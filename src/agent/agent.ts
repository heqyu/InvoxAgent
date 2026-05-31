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
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@zed-industries/agent-client-protocol";
import { log } from "../log.js";
import type { LLMMessage, LLMProvider, ParsedToolCall } from "../llm/types.js";
import { SessionStore, type PersistedSession } from "../persistence.js";
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
  /** Lazily created on first save() call so we don't hit disk for ephemeral cwd. */
  store?: SessionStore;
  createdAt: number;
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
        loadSession: true,
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
      createdAt: Date.now(),
    });
    log.info("session created", { id, cwd: params.cwd });
    return { sessionId: id };
  }

  /**
   * Resume a session that was previously persisted. Per ACP:
   *   1. Hydrate session from disk
   *   2. Stream the entire history back as session/update notifications
   *      so the client rebuilds its UI
   *   3. Resolve LoadSessionResponse only after replay is done
   *
   * If the sessionId isn't on disk we fail with a clear error — Zed shows
   * "Failed to Launch / Loading or resuming sessions is not supported by
   * this agent" only when the agent doesn't advertise loadSession; once
   * advertised, an unknown id surfaces as a regular RPC error.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const store = new SessionStore(params.cwd);
    const snapshot = store.load(params.sessionId);
    if (!snapshot) {
      throw new Error(
        `session ${params.sessionId} not found on disk under ${store.rootDir()}`,
      );
    }

    log.info("loadSession", {
      sessionId: snapshot.id,
      historyLen: snapshot.history.length,
      cwd: params.cwd,
    });

    // Recreate live state. cwd from the request wins (project may have moved).
    const session: Session = {
      id: snapshot.id,
      cwd: params.cwd,
      history: snapshot.history.slice(),
      abort: new AbortController(),
      toolState: {
        readPaths: new Set<string>(),
        cache: new FileCache(),
      },
      store,
      createdAt: snapshot.createdAt,
    };
    this.sessions.set(session.id, session);

    // Replay history → client. We translate every stored message to the
    // session/update notification(s) Zed needs to repaint its conversation.
    await this.replayHistory(session);

    return {} as LoadSessionResponse;
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
    let stopReason: "end_turn" | "cancelled" | "max_turn_requests" = "max_turn_requests";
    try {
      for (let iter = 0; iter < max; iter++) {
        const result = await this.runOneIteration(session);
        if (result.kind === "stop") {
          stopReason = result.reason;
          break;
        }
        if (session.abort.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
        // else: tool calls were executed, history extended → continue loop
      }
      if (stopReason === "max_turn_requests") {
        log.warn("prompt: hit max iterations", { sessionId: session.id, max });
      }
    } finally {
      // Persist regardless of how we exited (end_turn / cancelled / max).
      // This is the only place we save: every meaningful boundary the user
      // might want to resume from.
      this.persist(session);
    }
    return { stopReason };
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

  /** Save the session to disk. Quiet on failure (logged inside the store). */
  private persist(session: Session): void {
    if (!session.store) session.store = new SessionStore(session.cwd);
    const snapshot: PersistedSession = {
      version: 1,
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      history: session.history,
    };
    session.store.save(snapshot);
  }

  /**
   * Replay a hydrated session's history to the client as session/update
   * notifications, so the editor's conversation view rebuilds. Required
   * by ACP's session/load contract.
   *
   * Translation rules (OAI message → ACP notifications):
   *   - role:user                       → user_message_chunk
   *   - role:assistant (no tool_calls)  → agent_message_chunk
   *   - role:assistant (with tool_calls)→ agent_message_chunk for text part,
   *                                       then one tool_call notification
   *                                       per tool call (status:in_progress)
   *   - role:tool (matching tool_call)  → tool_call_update for the same id
   *                                       carrying the tool result text
   */
  private async replayHistory(session: Session): Promise<void> {
    // Build a quick map: tool_call_id → its result message, so we can pair
    // the assistant's tool_calls[] with the corresponding tool result in
    // a single pass.
    const toolResultById = new Map<string, LLMMessage>();
    for (const m of session.history) {
      if (m.role === "tool" && m.tool_call_id) toolResultById.set(m.tool_call_id, m);
    }

    for (const m of session.history) {
      if (m.role === "user") {
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: textOf(m.content) },
          },
        });
        continue;
      }

      if (m.role === "assistant") {
        const text = textOf(m.content);
        if (text.length > 0) {
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
        for (const call of m.tool_calls ?? []) {
          // tool_call (start) notification.
          const tool = getTool(call.name);
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: call.id,
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              status: "in_progress",
              rawInput: safeParseJSON(call.arguments) ?? { raw: call.arguments },
            },
          });
          // tool_call_update (completion) notification carrying the result.
          const result = toolResultById.get(call.id);
          const resultText = result ? textOf(result.content) : "(no recorded result)";
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: call.id,
              status: "completed",
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              content: [{ type: "content", content: { type: "text", text: resultText } }],
            },
          });
        }
        continue;
      }
      // role:tool messages are emitted alongside their parent assistant
      // turn above; nothing to do here.
    }
  }
}

function extractText(blocks: PromptRequest["prompt"]): string {
  return blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * LLMMessage.content can be string | null (assistants with only tool_calls).
 * Reduce to a string for replay, never undefined / null in the stream.
 */
function textOf(content: string | null | undefined): string {
  return typeof content === "string" ? content : "";
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
