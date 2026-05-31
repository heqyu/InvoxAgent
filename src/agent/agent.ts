// InvoxAgent: implements the ACP `Agent` interface.
//
// One ACP connection = one InvoxAgent. One agent owns N sessions
// (one per session/new request). Each session has its own history,
// its own AbortController for cancellation, and its own SessionToolState
// (read-paths set + file content cache) shared across the session's
// tool calls.
//
// prompt() loop:
//   append user msg → up to MAX_ITERATIONS:
//     stream LLM → emit agent_message_chunks, collect tool_calls
//     on finish:
//       no tool_calls   → end_turn
//       has tool_calls  → for each: emit tool_call, run, emit tool_call_update,
//                          append tool result → continue
//   exceeded → max_turn_requests
//
// MAX_ITERATIONS defaults to 50; override via INVOX_MAX_ITERATIONS env.

import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@zed-industries/agent-client-protocol";
import { log } from "../log.js";
import type { LLMMessage, LLMProvider, ParsedToolCall } from "../llm/types.js";
import { FileCache } from "../tools/cache.js";
import { kindFromTier } from "../tools/permissions.js";
import { getTool, TOOL_SPECS } from "../tools/registry.js";
import { executeTool } from "../tools/router.js";
import type { PermissionPolicy, SessionToolState } from "../tools/types.js";

function maxIterations(): number {
  const raw = process.env["INVOX_MAX_ITERATIONS"];
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}

interface Session {
  id: string;
  cwd: string;
  history: LLMMessage[];
  abort: AbortController;
  toolState: SessionToolState;
}

export class InvoxAgent implements Agent {
  readonly conn: AgentSideConnection;
  private clientCaps: ClientCapabilities = {};
  private sessions = new Map<string, Session>();
  private provider: LLMProvider;
  private policy: PermissionPolicy;

  constructor(conn: AgentSideConnection, provider: LLMProvider, policy: PermissionPolicy = "never") {
    this.conn = conn;
    this.provider = provider;
    this.policy = policy;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCaps = params.clientCapabilities ?? {};
    log.info("initialize", {
      provider: this.provider.name,
      clientProtocolVersion: params.protocolVersion,
      clientCaps: this.clientCaps,
    });

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      cwd: params.cwd,
      history: [],
      abort: new AbortController(),
      toolState: {
        readPaths: new Set<string>(),
        cache: new FileCache(),
      },
    });
    log.info("session created", { id, cwd: params.cwd });
    return { sessionId: id };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);

    session.abort = new AbortController();

    const userText = extractText(params.prompt);
    log.info("prompt received", {
      sessionId: session.id,
      userText,
      historyLen: session.history.length,
    });
    session.history.push({ role: "user", content: userText });

    const max = maxIterations();
    for (let iter = 0; iter < max; iter++) {
      const result = await this.runOneIteration(session);
      if (result.kind === "stop") return { stopReason: result.reason };
      if (session.abort.signal.aborted) return { stopReason: "cancelled" };
      // else: tool calls were executed, history extended → continue loop
    }
    log.warn("prompt: hit max iterations", { sessionId: session.id, max });
    return { stopReason: "max_turn_requests" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      log.warn("cancel: unknown sessionId", { sessionId: params.sessionId });
      return;
    }
    log.info("cancel", { sessionId: session.id });
    session.abort.abort();
  }

  /**
   * One LLM call → handle its tool_calls (if any) → return whether the turn
   * should end. The caller loops on `kind === "continue"`.
   */
  private async runOneIteration(
    session: Session,
  ): Promise<{ kind: "stop"; reason: "end_turn" | "cancelled" } | { kind: "continue" }> {
    let assistantText = "";
    const toolCalls: ParsedToolCall[] = [];
    let finishReason: "stop" | "tool_calls" | "length" | "other" = "other";

    try {
      for await (const delta of this.provider.stream({
        messages: session.history,
        signal: session.abort.signal,
        tools: TOOL_SPECS,
      })) {
        if (session.abort.signal.aborted) break;
        switch (delta.kind) {
          case "text":
            if (delta.text.length > 0) {
              assistantText += delta.text;
              await this.conn.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: delta.text },
                },
              });
            }
            break;
          case "tool_call":
            toolCalls.push(delta.call);
            break;
          case "finish":
            finishReason = delta.reason;
            break;
        }
      }
    } catch (err) {
      if (isAbort(err)) {
        if (assistantText) session.history.push({ role: "assistant", content: assistantText });
        return { kind: "stop", reason: "cancelled" };
      }
      log.error("provider stream failed", err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (session.abort.signal.aborted) {
      if (assistantText) session.history.push({ role: "assistant", content: assistantText });
      return { kind: "stop", reason: "cancelled" };
    }

    if (toolCalls.length === 0 || finishReason !== "tool_calls") {
      // Plain text reply, no tools requested → end of turn.
      session.history.push({ role: "assistant", content: assistantText });
      return { kind: "stop", reason: "end_turn" };
    }

    // Persist the assistant turn (text + the tool_calls it requested) before executing.
    session.history.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls,
    });

    // Execute tools sequentially.
    for (const call of toolCalls) {
      // Pick kind + title from the registered tool when known. Zed's UI
      // picks the card layout from the FIRST tool_call notification, so
      // setting the right kind here matters.
      const tool = getTool(call.name);
      const startKind = tool ? kindFromTier(tool.tier) : "other";
      const startTitle = startTitleFor(call);

      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: call.id,
          title: startTitle,
          kind: startKind,
          status: "in_progress",
          rawInput: safeParseJSON(call.arguments) ?? { raw: call.arguments },
        },
      });

      const r = await executeTool(call.name, call.arguments, {
        conn: this.conn,
        sessionId: session.id,
        cwd: session.cwd,
        caps: this.clientCaps,
        signal: session.abort.signal,
        policy: this.policy,
        toolCallId: call.id,
        state: session.toolState,
      });

      log.info("tool result", {
        name: call.name,
        ok: r.ok,
        resultPreview:
          r.resultText.length > 300
            ? r.resultText.slice(0, 300) + ` …(+${r.resultText.length - 300} more bytes)`
            : r.resultText,
      });

      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: call.id,
          status: r.ok ? "completed" : "failed",
          title: r.title,
          kind: r.kind,
          content: r.acpContent,
        },
      });

      session.history.push({
        role: "tool",
        tool_call_id: call.id,
        content: r.resultText,
        name: call.name,
      });
    }

    return { kind: "continue" };
  }
}

function extractText(blocks: PromptRequest["prompt"]): string {
  return blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function safeParseJSON(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Title to display while the tool is running. Prefers the LLM-supplied
 * `description` arg; otherwise falls back to a synthesized phrase.
 */
function startTitleFor(call: ParsedToolCall): string {
  const parsed = safeParseJSON(call.arguments);
  const desc = typeof parsed?.["description"] === "string" ? parsed["description"].trim() : "";
  if (desc) return desc;
  if (!parsed) return call.name;
  switch (call.name) {
    case "read_file": {
      const p = String(parsed["path"] ?? "");
      const offset = parsed["offset"];
      return p
        ? offset
          ? `Read ${p} (lines ${String(offset)}+)`
          : `Read ${p}`
        : "Read file";
    }
    case "write_file": {
      const p = String(parsed["path"] ?? "");
      return p ? `Write ${p}` : "Write file";
    }
    case "edit_file": {
      const p = String(parsed["path"] ?? "");
      return p ? `Edit ${p}` : "Edit file";
    }
    case "bash": {
      const c = String(parsed["command"] ?? "");
      return c ? `\`${c.slice(0, 80)}${c.length > 80 ? "…" : ""}\`` : "Run command";
    }
    default:
      return call.name;
  }
}

function isAbort(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err && (err as { name: unknown }).name === "AbortError")
    return true;
  if (err instanceof Error && /aborted/i.test(err.message)) return true;
  return false;
}
