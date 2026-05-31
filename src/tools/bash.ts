// bash: spawn a shell command locally (not via ACP terminal/*).
//
// See git history for why we don't use ACP terminal: empirically Zed on
// Windows mangles cmd /c args. node:child_process with shell:true gives
// us deterministic semantics on every platform.

import { spawn } from "node:child_process";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { errorResult, type Tool, type ToolExecContext, type ToolExecResult } from "./types.js";

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

  return new Promise<ToolExecResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
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
        acpContent: [{ type: "content", content: { type: "text", text: display } }],
        kind: "execute",
        title: titleFor(args, command),
        ok: false,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);

      const combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const display =
        `$ ${command}\n` +
        `exit=${exitCode ?? "?"}${signal ? ` signal=${signal}` : ""}\n` +
        (combined.length > 0 ? combined : "(no output)");

      resolveResult({
        resultText: display,
        acpContent: [{ type: "content", content: { type: "text", text: display } }],
        kind: "execute",
        title: titleFor(args, command),
        ok: exitCode === 0,
      });
    });
  });
}

function titleFor(args: Record<string, unknown>, command: string): string {
  const desc = typeof args["description"] === "string" ? args["description"].trim() : "";
  if (desc) return desc;
  return `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""}`;
}

export const bashTool: Tool = {
  name: "bash",
  tier: "execute",
  spec,
  execute,
};
