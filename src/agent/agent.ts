// InvoxAgent: implements the ACP `Agent` interface.
//
// Stage 3 scope: orchestrate the LLM-tool loop.
//
//   prompt():
//     append user msg → loop up to MAX_ITERATIONS:
//       call provider.stream(messages, tools, signal)
//       accumulate streamed text, emit ACP agent_message_chunks
//       collect tool_call deltas
//       on finish:
//         if no tool_calls: append assistant text → return end_turn
//         if tool_calls:
//           append assistant msg (with tool_calls)
//           for each tool_call:
//             emit ACP tool_call (in_progress)
//             run tool via tools/router
//             emit ACP tool_call_update (completed | failed)
//             append role:tool message with result
//           continue loop
//     after MAX_ITERATIONS: return max_turn_requests
//
// Stage-3 user decisions (PLAN.md):
//   - tools: read_file, write_file, bash
//   - permission: never ask (router doesn't call requestPermission)
//   - loop bound: MAX_ITERATIONS = 8

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
import { TOOL_SPECS } from "../tools/specs.js";
import { executeTool, type PermissionPolicy } from "../tools/router.js";

const MAX_ITERATIONS = 8;

interface Session {
  id: string;
  cwd: string;
  history: LLMMessage[];
  abort: AbortController;
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

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const result = await this.runOneIteration(session);
      if (result.kind === "stop") return { stopReason: result.reason };
      if (session.abort.signal.aborted) return { stopReason: "cancelled" };
      // else: tool calls were executed, history extended → continue loop
    }
    log.warn("prompt: hit MAX_ITERATIONS", { sessionId: session.id });
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

    // Execute tools sequentially. Parallel could be a stage-5 polish, but
    // sequential keeps logs sane and matches what most agent UIs expect.
    for (const call of toolCalls) {
      // Pick a meaningful kind + title up front. Zed's UI renders the card
      // using the kind set on the FIRST tool_call notification (the
      // tool_call_update later only patches fields on the same id), so we
      // need a real kind here, not "other" — otherwise Zed gives us a
      // minimal card with no output region.
      const startKind = guessKind(call.name);
      const startTitle = guessTitle(call.name, call.arguments);

      // Notify client: tool starting.
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
      });

      // Visibility for diagnosing 'LLM keeps retrying tool' loops:
      // dump exactly what the LLM will see back as the tool message.
      log.info("tool result", {
        name: call.name,
        ok: r.ok,
        resultPreview: r.resultText.length > 300
          ? r.resultText.slice(0, 300) + ` …(+${r.resultText.length - 300} more bytes)`
          : r.resultText,
      });

      // Notify client: tool finished.
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

      // Feed the tool result back to the LLM for the next iteration.
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
 * Map our internal tool name to ACP `ToolKind` so the client UI picks the
 * right icon and (importantly for Zed) the right card layout.
 */
function guessKind(name: string): "read" | "edit" | "execute" | "other" {
  switch (name) {
    case "read_file":
      return "read";
    case "write_file":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

/**
 * Build a human-readable title that fits a card header. Prefers the LLM's
 * own `description` arg (filled per the schema in tools/specs.ts) so the
 * card shows what the LLM intended in plain language. Falls back to a
 * sensible default per tool name.
 */
function guessTitle(name: string, rawArgs: string): string {
  const parsed = safeParseJSON(rawArgs);
  const desc = typeof parsed?.["description"] === "string" ? parsed["description"].trim() : "";
  if (desc) return desc;
  if (!parsed) return name;
  switch (name) {
    case "read_file": {
      const p = String(parsed["path"] ?? "");
      return p ? `Read ${p}` : "Read file";
    }
    case "write_file": {
      const p = String(parsed["path"] ?? "");
      return p ? `Write ${p}` : "Write file";
    }
    case "bash": {
      const c = String(parsed["command"] ?? "");
      return c ? `\`${c.slice(0, 80)}${c.length > 80 ? "…" : ""}\`` : "Run command";
    }
    default:
      return name;
  }
}

function isAbort(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err && (err as { name: unknown }).name === "AbortError") return true;
  if (err instanceof Error && /aborted/i.test(err.message)) return true;
  return false;
}
