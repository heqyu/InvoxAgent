// bash: run a shell command and surface it to the user.
//
// Two execution paths:
//
// 1. ACP terminal (preferred when the client advertises `terminal: true`,
//    e.g. Zed). The command runs inside a client-managed terminal and the
//    tool_call content carries `{ type: "terminal", terminalId }`. Zed
//    renders the live command header (cwd + colored command) and streamed
//    ANSI output natively — exactly what users expect from a "Run Command"
//    card. We then read the final output via `currentOutput()` and feed it
//    back to the LLM as plain text so the model sees a familiar shape.
//
// 2. Local spawn fallback (when the client doesn't speak terminal/*, e.g.
//    smoke scripts or non-Zed clients). Same plain-text result either way.
//
// Shell selection (Windows): we prefer Git Bash (`bash -lc <cmd>`) over
// `cmd.exe /d /s /c <cmd>`. Reason: when Zed creates a ConPTY-hosted
// terminal on Windows and we run cmd.exe through it, cmd occasionally
// emits its interactive banner ("Microsoft Windows [版本 ...]" + prompt)
// and exits before the actual command's output is captured by
// currentOutput(), leaving the LLM with an empty-looking result and
// triggering "is this an empty repo?" rabbit holes. Git Bash under the
// same ConPTY behaves correctly. Users can force a specific shell via
// INVOX_SHELL ("bash" | "cmd" | absolute path to an executable). On
// non-Windows, /bin/sh -c is used as before.
//
// On Windows, ACP terminal/create historically mangled commands when the
// whole `cmd /c <command>` was crammed into the `command` field — Zed would
// re-tokenize and break quoting. We avoid that by passing the shell as
// `command` and the user command as a single element of `args`, so the
// client doesn't get a chance to re-split.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Execute a shell command in the session's working directory. " +
      "Pipes / redirects / quoting work the way the OS's default shell " +
      "(cmd on Windows, /bin/sh on POSIX) parses them. Returns combined " +
      "stdout+stderr and the exit code. Use this for build/test/git/grep " +
      "commands; for editing files prefer edit_file.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The full command line to run.",
        },
        description: DESCRIPTION_FIELD,
      },
      required: ["command", "description"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const command = String(args["command"] ?? "");
  if (!command) return errorResult("missing 'command'", "execute", "bash");
  log.info("tool: bash", { command });

  if (ctx.caps.terminal === true) {
    return runViaAcpTerminal(command, args, ctx);
  }
  return runViaLocalSpawn(command, args, ctx);
}

// ── ACP terminal path (Zed) ──────────────────────────────────────────

async function runViaAcpTerminal(
  command: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  // Pass the shell as `command` and the user's command line as a single
  // arg element. This sidesteps Zed's argv-splitting on Windows.
  const { shellCmd, shellArgs } = buildShellInvocation(command);

  const terminal = await ctx.conn.createTerminal({
    sessionId: ctx.sessionId,
    command: shellCmd,
    args: shellArgs,
    cwd: ctx.cwd,
  });

  const onAbort = (): void => {
    terminal.kill().catch(() => {
      /* terminal may have already exited */
    });
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const title = titleFor(args, command);

  // Attach the embedded terminal to the tool-call card *immediately*,
  // before waitForExit() blocks. Zed only renders the collapsible /
  // expandable terminal block when it sees a `{type:"terminal", terminalId}`
  // content entry while the call is still in_progress. If we wait until
  // after the command exits, fast commands (git log, etc.) finish before
  // Zed gets a chance to mount the terminal pane and the user just sees
  // a bare title with no expandable output. Any later tool_call_update we
  // emit replaces this content (we re-send the same terminalId), so this
  // is a pure UX upgrade — no double rendering.
  await ctx.conn.sessionUpdate({
    sessionId: ctx.sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: ctx.toolCallId,
      status: "in_progress",
      title,
      kind: "execute",
      content: [{ type: "terminal", terminalId: terminal.id }],
    },
  }).catch(() => {
    // Best-effort — if the client doesn't accept the in-flight update,
    // the post-exit update below still carries the same terminalId.
  });

  try {
    const exit = await terminal.waitForExit();
    const out = await terminal.currentOutput();
    const exitCode = exit.exitCode ?? null;
    const signal = exit.signal ?? null;

    const display =
      `$ ${command}\n` +
      `exit=${exitCode ?? "?"}${signal ? ` signal=${signal}` : ""}\n` +
      (out.output.length > 0 ? out.output : "(no output)") +
      (out.truncated ? "\n[output truncated by client]" : "");

    return {
      resultText: display,
      acpContent: [{ type: "terminal", terminalId: terminal.id }],
      kind: "execute",
      title,
      ok: exitCode === 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const display = `$ ${command}\nerror: ${message}\n`;
    return {
      resultText: display,
      acpContent: [{ type: "terminal", terminalId: terminal.id }],
      kind: "execute",
      title,
      ok: false,
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    // Tool calls already containing this terminalId keep displaying its
    // output after release, per the ACP spec.
    terminal.release().catch(() => {
      /* best-effort */
    });
  }
}

function buildShellInvocation(command: string): {
  shellCmd: string;
  shellArgs: string[];
} {
  if (process.platform === "win32") {
    const bash = pickWindowsShell();
    if (bash) {
      // -l: login shell so /etc/profile + ~/.bashrc set PATH (so `git`,
      //     `node`, etc. resolve the same way they would in Git Bash).
      // -c: run the command string and exit.
      return { shellCmd: bash, shellArgs: ["-lc", command] };
    }
    // /d disables AutoRun, /s + surrounding quotes preserve quoting inside
    // the command, /c runs and exits.
    return { shellCmd: "cmd.exe", shellArgs: ["/d", "/s", "/c", command] };
  }
  return { shellCmd: "/bin/sh", shellArgs: ["-c", command] };
}

/**
 * Resolve the preferred shell on Windows. Cached for the process lifetime;
 * we log the choice once on first use so the user can confirm in invox.log.
 *
 * Returns an absolute path to bash.exe (Git Bash / MSYS / WSL-side bash on
 * PATH), or `null` to signal "fall back to cmd.exe". Honors INVOX_SHELL:
 *   - "cmd"               → force cmd.exe (returns null)
 *   - "bash"              → search the standard Git Bash locations
 *   - any absolute path   → use that executable verbatim if it exists
 */
let cachedWindowsShell: { value: string | null } | undefined;
function pickWindowsShell(): string | null {
  if (cachedWindowsShell) return cachedWindowsShell.value;

  const override = (process.env["INVOX_SHELL"] ?? "").trim();
  let chosen: string | null;
  if (override.toLowerCase() === "cmd") {
    chosen = null;
  } else if (override && override.toLowerCase() !== "bash" && isAbsolute(override)) {
    chosen = existsSync(override) ? override : null;
  } else {
    chosen = findGitBash();
  }

  cachedWindowsShell = { value: chosen };
  log.info("bash: shell selected", {
    shell: chosen ?? "cmd.exe",
    override: override || undefined,
  });
  return chosen;
}

/**
 * Probe known Git Bash install locations. We deliberately don't trust PATH
 * lookup alone — Zed's ACP-spawned subprocess sometimes inherits a slimmed-
 * down PATH that omits Git's bin directory.
 */
function findGitBash(): string | null {
  const candidates: string[] = [];
  const env = process.env;
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env["LOCALAPPDATA"] ?? "";
  const userProfile = env["USERPROFILE"] ?? "";

  candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  if (localAppData) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  }
  if (userProfile) {
    // Common scoop/portable layouts.
    candidates.push(`${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
    candidates.push(`${userProfile}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`);
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Local spawn fallback (non-ACP-terminal clients) ──────────────────

async function runViaLocalSpawn(
  command: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  return new Promise<ToolExecResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Use the same shell selection as the ACP terminal path so behavior is
    // consistent across transports (Git Bash on Windows when available,
    // cmd.exe fallback). Passing `shell: true` to spawn would always pick
    // cmd.exe on Windows, defeating the purpose of pickWindowsShell().
    const { shellCmd, shellArgs } = buildShellInvocation(command);
    const child = spawn(shellCmd, shellArgs, {
      cwd: ctx.cwd,
      windowsHide: true,
    });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // process may have already exited
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      const display = `$ ${command}\nerror: ${err.message}\n`;
      resolveResult({
        resultText: display,
        acpContent: [
          { type: "content", content: { type: "text", text: display } },
        ],
        kind: "execute",
        title: titleFor(args, command),
        ok: false,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);

      const combined =
        stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const display =
        `$ ${command}\n` +
        `exit=${exitCode ?? "?"}${signal ? ` signal=${signal}` : ""}\n` +
        (combined.length > 0 ? combined : "(no output)");

      resolveResult({
        resultText: display,
        acpContent: [
          { type: "content", content: { type: "text", text: display } },
        ],
        kind: "execute",
        title: titleFor(args, command),
        ok: exitCode === 0,
      });
    });
  });
}

// ── Title fallback (used only when agent.ts can't compute one) ───────

function titleFor(_args: Record<string, unknown>, command: string): string {
  // Command-first, matching agent.ts:startTitleFor("bash"). The LLM's
  // free-form description is intentionally NOT used: it would clobber
  // the command-as-title that the user already saw on the in_progress
  // card, replacing e.g. `git log -1 --stat` with a translated phrase
  // and breaking copy/paste of the actual command.
  return `\`${command.slice(0, 80)}${command.length > 80 ? "…" : ""}\``;
}

export const bashTool: Tool = {
  name: "bash",
  tier: "execute",
  spec,
  execute,
};
