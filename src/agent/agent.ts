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
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type ContentBlock,
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
import type {
  LLMMessage,
  LLMProvider,
  ParsedToolCall,
  UserContent,
} from "../llm/types.js";
import {
  SessionStore,
  sessionTtlDays,
  titleFromHistory,
  type PersistedSession,
} from "../persistence.js";
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
  store?: SessionStore;
  createdAt: number;
}

export class InvoxAgent implements Agent {
  readonly conn: AgentSideConnection;
  private clientCaps: ClientCapabilities = {};
  private sessions = new Map<string, Session>();
  private provider: LLMProvider;
  private policy: PermissionPolicy;

  constructor(
    conn: AgentSideConnection,
    provider: LLMProvider,
    policy: PermissionPolicy = "never",
  ) {
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
          image: true, // now we support image_url via OpenAI content-part array
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

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      cwd: params.cwd,
      history: [SYSTEM_MESSAGE],
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

    await this.replayHistory(session);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);

    session.abort = new AbortController();

    const userContent = buildUserContent(params.prompt);
    log.info("prompt received", {
      sessionId: session.id,
      userText: userContentPreview(userContent),
      historyLen: session.history.length,
    });
    session.history.push({ role: "user", content: userContent });

    const max = maxIterations();
    let stopReason: "end_turn" | "cancelled" | "max_turn_requests" =
      "max_turn_requests";
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
      }
      if (stopReason === "max_turn_requests") {
        log.warn("prompt: hit max iterations", { sessionId: session.id, max });
      }
    } finally {
      this.persist(session);
    }
    return { stopReason };
  }

  async cancel(_params: CancelNotification): Promise<void> {
    // not implemented yet
  }

  // ── private ──────────────────────────────────────────────────────────

  /**
   * Build user message content from ACP ContentBlocks.
   *
   * Returns OpenAI-compatible `UserContent` directly:
   *   - text blocks        → { type: "text", text }
   *   - resource_link       → { type: "text", text: "File: <path>" }  (we tell the LLM the path)
   *   - image (with data)  → { type: "image_url", image_url: { url: "data:..." } }
   *   - image (with uri)   → { type: "image_url", image_url: { url: uri } }
   *   - resource (text)    → inlined as text
   *
   * If the result is a single text part, collapse to plain string.
   */
  private async runOneIteration(
    session: Session,
  ): Promise<
    { kind: "stop"; reason: "end_turn" | "cancelled" } | { kind: "continue" }
  > {
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
        if (assistantText)
          session.history.push({ role: "assistant", content: assistantText });
        return { kind: "stop", reason: "cancelled" };
      }
      log.error(
        "provider stream failed",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    if (session.abort.signal.aborted) {
      if (assistantText)
        session.history.push({ role: "assistant", content: assistantText });
      return { kind: "stop", reason: "cancelled" };
    }

    if (toolCalls.length === 0 || finishReason !== "tool_calls") {
      session.history.push({ role: "assistant", content: assistantText });
      return { kind: "stop", reason: "end_turn" };
    }

    session.history.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const tool = getTool(call.name);
      const startKind = tool ? kindFromTier(tool.tier) : "other";
      const startTitle = startTitleFor(call);
      const startLocations = startLocationsFor(call);

      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: call.id,
          title: startTitle,
          kind: startKind,
          status: "in_progress",
          rawInput: safeParseJSON(call.arguments) ?? { raw: call.arguments },
          ...(startLocations ? { locations: startLocations } : {}),
        },
      });

      log.info("tool start", {
        name: call.name,
        toolCallId: call.id,
        argsPreview: previewArgs(call.arguments),
      });
      const toolStartedAt = Date.now();

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

      log.info("tool end", {
        name: call.name,
        toolCallId: call.id,
        ok: r.ok,
        elapsedMs: Date.now() - toolStartedAt,
        resultBytes: r.resultText.length,
        resultPreview:
          r.resultText.length > 200
            ? r.resultText.slice(0, 200) +
              ` …(+${r.resultText.length - 200} more bytes)`
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
          ...(r.locations ? { locations: r.locations } : {}),
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

  private persist(session: Session): void {
    if (!session.store) {
      session.store = new SessionStore(session.cwd);
      session.store.prune(sessionTtlDays());
    }
    const snapshot: PersistedSession = {
      version: 1,
      id: session.id,
      cwd: session.cwd,
      title: titleFromHistory(session.history),
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      history: session.history,
    };
    session.store.save(snapshot);
  }

  private async replayHistory(session: Session): Promise<void> {
    const toolResultById = new Map<string, LLMMessage>();
    for (const m of session.history) {
      if (m.role === "tool" && m.tool_call_id)
        toolResultById.set(m.tool_call_id, m);
    }

    for (const m of session.history) {
      if (m.role === "user") {
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: userContentPreview(m.content) },
          },
        });
        continue;
      }

      if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content : "";
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
          const tool = getTool(call.name);
          const replayLocations = startLocationsFor(call);
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: call.id,
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              status: "in_progress",
              rawInput: safeParseJSON(call.arguments) ?? {
                raw: call.arguments,
              },
              ...(replayLocations ? { locations: replayLocations } : {}),
            },
          });
          const result = toolResultById.get(call.id);
          const resultText = result
            ? typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content)
            : "(no recorded result)";
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: call.id,
              status: "completed",
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: resultText },
                },
              ],
              ...(replayLocations ? { locations: replayLocations } : {}),
            },
          });
        }
        continue;
      }
    }
  }
}

// ── System message ───────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are a helpful coding assistant embedded in Zed (a code editor).\n` +
  `\n` +
  `When the user sends a message you may receive multiple content blocks:\n` +
  `- text: plain user text\n` +
  `- resource_link (file): the user attached a file — use the Read tool to read it before answering\n` +
  `- image: the user attached an image — refer to it in your answer\n` +
  `\n` +
  `Always prefer using tools to answer questions about the codebase. ` +
  `If a file is referenced but not yet read, read it first.`;
const SYSTEM_MESSAGE: LLMMessage = {
  role: "system",
  content: SYSTEM_PROMPT,
};

// ── Prompt content builder ──────────────────────────────────────────

/**
 * Convert ACP ContentBlocks into OpenAI-compatible `UserContent`.
 *
 * Strategy:
 *   - Collect all parts into an array of ChatCompletionContentPart.
 *   - If the result is a single plain-text part, collapse to a string
 *     (simpler for logs and for providers that don't support arrays).
 */
function buildUserContent(blocks: ContentBlock[]): UserContent {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;

      case "resource_link": {
        // Tell the LLM which file was attached by name/path.
        // The actual file content is NOT inlined — the LLM should call Read tool.
        const label = block.name ?? block.uri ?? "attached file";
        const path = uriToPath(block.uri);
        parts.push({
          type: "text",
          text: `[File: ${label}]${path ? ` (${path})` : ""}`,
        });
        break;
      }

      case "image": {
        // Inline data URI or pass through the URI.
        const url =
          block.data && block.mimeType
            ? `data:${block.mimeType};base64,${block.data}`
            : (block.uri ?? "");
        if (url) {
          parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }

      case "resource": {
        // Inline text resource directly.
        const txt = "text" in block.resource ? block.resource.text : undefined;
        if (txt) parts.push({ type: "text", text: txt });
        break;
      }

      default:
        // Ignore unknown block types.
        break;
    }
  }

  // Collapse: single text part → plain string
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }

  return parts as OpenAI.Chat.Completions.ChatCompletionContentPart[];
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = uri.slice("file://".length);
  // Windows drive letter: /C:/... → C:/...
  if (p.length > 2 && p[0] === "/" && p[2] === ":") p = p.slice(1);
  // Strip fragment (#L10) and query (?symbol=...)
  const hash = p.indexOf("#");
  if (hash !== -1) p = p.slice(0, hash);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  return p;
}

/** Plain-text preview for logging (strips image data). */
function userContentPreview(content: string | UserContent): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join(" ");
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeParseJSON(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function previewArgs(rawArgs: string): unknown {
  const parsed = safeParseJSON(rawArgs);
  if (!parsed) {
    return rawArgs.length > 100 ? rawArgs.slice(0, 100) + "…" : rawArgs;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 100) {
      out[k] = v.slice(0, 100) + `…(+${v.length - 100})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function startTitleFor(call: ParsedToolCall): string {
  const parsed = safeParseJSON(call.arguments);
  // For file-touching tools we deliberately ignore the LLM-supplied
  // `description` and put the path in the title — Zed renders the title
  // next to a "Go to File" affordance, so a translated/paraphrased
  // description would hide the click-target. The description still
  // reaches the user via the tool result body.
  if (parsed) {
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
        return c
          ? `\`${c.slice(0, 80)}${c.length > 80 ? "…" : ""}\``
          : "Run command";
      }
    }
  }
  // Non-file tools fall back to the LLM's free-form description.
  const desc =
    typeof parsed?.["description"] === "string"
      ? parsed["description"].trim()
      : "";
  if (desc) return desc;
  return call.name;
}

/**
 * Build ACP `locations` for the initial tool_call notification, so Zed's
 * "Go to File" / follow-along UI lights up while the tool is still
 * running (not just after completion). Only the file-touching tools
 * have a meaningful path at call-time.
 */
function startLocationsFor(call: ParsedToolCall): { path: string }[] | undefined {
  const parsed = safeParseJSON(call.arguments);
  if (!parsed) return undefined;
  if (call.name === "read_file" || call.name === "write_file" || call.name === "edit_file") {
    const p = typeof parsed["path"] === "string" ? parsed["path"].trim() : "";
    if (p) return [{ path: p }];
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  )
    return true;
  if (err instanceof Error && /aborted/i.test(err.message)) return true;
  return false;
}
