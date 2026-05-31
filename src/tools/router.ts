// Tool router — translates an OpenAI-style tool_call into ACP method calls.
//
// Stage-3 user decision (default): "never ask" permission policy. Stage-5
// adds an env-driven escalation:
//
//   INVOX_PERMISSIONS=never   default; agent runs tools directly
//   INVOX_PERMISSIONS=writes  reads pass through; writes/execute go through
//                             session/request_permission
//   INVOX_PERMISSIONS=always  every tool call goes through request_permission
//
// CHOICE: per-tool risk tier rather than per-tool policy. Adding a new tool
// only requires picking its tier; the gate logic stays in one place.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type {
  AgentSideConnection,
  ClientCapabilities,
  ToolCallContent,
} from "@zed-industries/agent-client-protocol";
import { log } from "../log.js";

export type PermissionPolicy = "never" | "writes" | "always";

type RiskTier = "read" | "write" | "execute";

export interface ToolExecContext {
  conn: AgentSideConnection;
  sessionId: string;
  cwd: string;
  caps: ClientCapabilities;
  signal: AbortSignal;
  policy: PermissionPolicy;
  toolCallId: string;
}

export interface ToolExecResult {
  /** String result fed back to the LLM as the `tool` message body. */
  resultText: string;
  /** Rich content for the ACP `tool_call_update` notification. */
  acpContent: ToolCallContent[];
  /** ACP `kind` discriminator for the tool_call notification. */
  kind: "read" | "edit" | "execute" | "other";
  /** Human-readable title; shown in the client's UI. */
  title: string;
  /** Whether the call succeeded (drives status: completed | failed | cancelled). */
  ok: boolean;
  /** True iff the user denied the action; the LLM should be told. */
  denied?: boolean;
}

const RISK: Record<string, RiskTier> = {
  read_file: "read",
  write_file: "write",
  bash: "execute",
};

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs.trim() === "" ? {} : (JSON.parse(rawArgs) as Record<string, unknown>);
  } catch (e) {
    return errorResult(`bad arguments JSON: ${(e as Error).message}`, "other", `${name}(?)`);
  }

  const tier = RISK[name];
  if (tier && needsPermission(tier, ctx.policy)) {
    const granted = await requestPermission(name, args, ctx);
    if (!granted) {
      log.info("permission denied", { name });
      return {
        resultText: `User denied permission for ${name}.`,
        acpContent: [
          { type: "content", content: { type: "text", text: `Permission denied for ${name}.` } },
        ],
        kind: kindFromTier(tier),
        title: `${name} (denied)`,
        ok: false,
        denied: true,
      };
    }
  }

  switch (name) {
    case "read_file":
      return readFile(args, ctx);
    case "write_file":
      return writeFile(args, ctx);
    case "bash":
      return bash(args, ctx);
    default:
      return errorResult(`unknown tool: ${name}`, "other", name);
  }
}

function needsPermission(tier: RiskTier, policy: PermissionPolicy): boolean {
  if (policy === "always") return true;
  if (policy === "writes") return tier === "write" || tier === "execute";
  return false;
}

function kindFromTier(tier: RiskTier): "read" | "edit" | "execute" {
  return tier === "read" ? "read" : tier === "write" ? "edit" : "execute";
}

async function requestPermission(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<boolean> {
  try {
    const res = await ctx.conn.requestPermission({
      sessionId: ctx.sessionId,
      toolCall: {
        toolCallId: ctx.toolCallId,
        title: `${name}(${JSON.stringify(args).slice(0, 80)})`,
        kind: kindFromTier(RISK[name] ?? "read"),
        rawInput: args,
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome === "selected") return res.outcome.optionId === "allow";
    return false; // cancelled = treat as deny
  } catch (e) {
    log.warn("requestPermission failed; defaulting to deny", String(e));
    return false;
  }
}

async function readFile(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  if (!rel) return errorResult("missing 'path'", "read", "read_file");
  if (!ctx.caps.fs?.readTextFile) {
    return errorResult("client does not advertise fs.readTextFile capability", "read", `read_file: ${rel}`);
  }
  const path = resolve(ctx.cwd, rel);
  log.info("tool: read_file", { path });
  try {
    const res = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
    const content = res.content;
    return {
      resultText: content,
      acpContent: [{ type: "content", content: { type: "text", text: content } }],
      kind: "read",
      title: `Read ${rel}`,
      ok: true,
    };
  } catch (e) {
    return errorResult(`read failed: ${(e as Error).message}`, "read", `read_file: ${rel}`);
  }
}

async function writeFile(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  const content = String(args["content"] ?? "");
  if (!rel) return errorResult("missing 'path'", "edit", "write_file");
  if (!ctx.caps.fs?.writeTextFile) {
    return errorResult("client does not advertise fs.writeTextFile capability", "edit", `write_file: ${rel}`);
  }
  const path = resolve(ctx.cwd, rel);
  log.info("tool: write_file", { path, bytes: content.length });

  let oldText: string | null = null;
  if (ctx.caps.fs?.readTextFile) {
    try {
      const r = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
      oldText = r.content;
    } catch {
      oldText = null;
    }
  }

  try {
    await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
    return {
      resultText: `wrote ${content.length} bytes to ${rel}`,
      acpContent: [
        {
          type: "diff",
          path,
          oldText,
          newText: content,
        },
      ],
      kind: "edit",
      title: `Wrote ${rel}`,
      ok: true,
    };
  } catch (e) {
    return errorResult(`write failed: ${(e as Error).message}`, "edit", `write_file: ${rel}`);
  }
}

async function bash(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const command = String(args["command"] ?? "");
  if (!command) return errorResult("missing 'command'", "execute", "bash");
  log.info("tool: bash", { command });

  // CHOICE: spawn the command ourselves via node:child_process instead of
  // ACP's terminal/* methods.
  //
  // Why: empirical observation against Zed on Windows showed that
  // createTerminal({command: "cmd.exe", args: ["/c", "ls -la"]}) launched
  // cmd.exe but its /c arg never reached the shell — every call returned
  // just the cmd startup banner and an empty prompt. The reference agent
  // visible in user screenshots also did not seem to use ACP terminal
  // (its output was clearly a real ls, not a cmd banner).
  //
  // By using Node's spawn we:
  //   - get full control of how the shell is invoked (shell:true uses the
  //     OS default shell with proper command-line construction)
  //   - capture stdout+stderr deterministically
  //   - don't depend on the client advertising the `terminal` capability
  //   - stay portable: same code on Windows / macOS / Linux
  //
  // Trade-off: the user doesn't get a live-updating terminal view in their
  // editor — but our stage-5 fix already returned content text rather than
  // a terminal handle, so the UX is identical to before.

  return new Promise<ToolExecResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,        // ← use OS default shell to interpret pipes/quotes
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
      const display =
        `$ ${command}\n` +
        `error: ${err.message}\n`;
      resolveResult({
        resultText: display,
        acpContent: [{ type: "content", content: { type: "text", text: display } }],
        kind: "execute",
        title: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""}`,
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
        title: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""}`,
        ok: exitCode === 0,
      });
    });
  });
}

function errorResult(
  msg: string,
  kind: "read" | "edit" | "execute" | "other",
  title: string,
): ToolExecResult {
  return {
    resultText: `ERROR: ${msg}`,
    acpContent: [{ type: "content", content: { type: "text", text: `Error: ${msg}` } }],
    kind,
    title,
    ok: false,
  };
}
