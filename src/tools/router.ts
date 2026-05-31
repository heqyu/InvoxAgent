// Tool router — translates an OpenAI-style tool_call into ACP method calls.
//
// PLAN §1 / stage-3 user decision: "never ask" permission policy. We do NOT
// invoke conn.requestPermission. The agent trusts the LLM. Future polish
// (stage 5) may add an env-knob to enable a permission gate.
//
// Capabilities are checked: if the client did not advertise fs.readTextFile,
// the read_file tool returns an error result the LLM can surface, rather
// than crashing the connection.

import { resolve } from "node:path";
import type {
  AgentSideConnection,
  ClientCapabilities,
  ToolCallContent,
} from "@zed-industries/agent-client-protocol";
import { log } from "../log.js";

export interface ToolExecContext {
  conn: AgentSideConnection;
  sessionId: string;
  cwd: string;
  caps: ClientCapabilities;
  signal: AbortSignal;
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
  /** Whether the call succeeded (drives status: completed | failed). */
  ok: boolean;
}

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

  // Best-effort old-text fetch so the client can render a real diff.
  let oldText: string | null = null;
  if (ctx.caps.fs?.readTextFile) {
    try {
      const r = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
      oldText = r.content;
    } catch {
      oldText = null; // file likely doesn't exist yet — that's fine
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
  if (!ctx.caps.terminal) {
    return errorResult("client does not advertise terminal capability", "execute", `bash`);
  }
  log.info("tool: bash", { command });

  // Spawn via shell so users can use pipes / redirects naturally.
  // Win/posix split: cmd.exe /c on Windows, /bin/sh -c elsewhere.
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/c", command] : ["-c", command];

  let term;
  try {
    term = await ctx.conn.createTerminal({
      sessionId: ctx.sessionId,
      command: shell,
      args: shellArgs,
      cwd: ctx.cwd,
      env: [],
    });
  } catch (e) {
    return errorResult(`createTerminal failed: ${(e as Error).message}`, "execute", `bash: ${command}`);
  }

  try {
    const exit = await term.waitForExit();
    const out = await term.currentOutput();
    const exitCode = exit.exitCode ?? null;
    const signal = exit.signal ?? null;
    const tail = out.output;
    const resultText =
      `exit=${exitCode ?? "null"}${signal ? ` signal=${signal}` : ""}\n` +
      `--- output ---\n${tail}`;
    return {
      resultText,
      acpContent: [{ type: "terminal", terminalId: term.id }],
      kind: "execute",
      title: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""}`,
      ok: exitCode === 0,
    };
  } finally {
    await term.release().catch(() => undefined);
  }
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
