// InvoxAgent: implements the ACP `Agent` interface.
//
// Stage 2 scope:
//   - takes an LLMProvider in its constructor (provider-agnostic core)
//   - prompt() appends user message to session history, streams provider
//     deltas as agent_message_chunk notifications, accumulates assistant
//     reply into history for multi-turn conversations
//   - cancel() aborts the provider's signal, stopping upstream LLM mid-stream
//
// Stages 3+ will extend prompt() with tool-call routing.

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
import type { LLMMessage, LLMProvider } from "../llm/types.js";

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

  constructor(conn: AgentSideConnection, provider: LLMProvider) {
    this.conn = conn;
    this.provider = provider;
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
    if (!session) {
      throw new Error(`unknown sessionId: ${params.sessionId}`);
    }

    // A new prompt = a fresh AbortController. Stale aborts from prior turns
    // must not affect this call.
    session.abort = new AbortController();

    const userText = extractText(params.prompt);
    log.info("prompt received", {
      sessionId: session.id,
      userText,
      historyLen: session.history.length,
    });

    session.history.push({ role: "user", content: userText });

    // Stream provider deltas → ACP agent_message_chunks. Accumulate the
    // assistant reply in `assembled` so it lands in history for the next turn.
    let assembled = "";
    try {
      for await (const delta of this.provider.stream({
        messages: session.history,
        signal: session.abort.signal,
      })) {
        if (session.abort.signal.aborted) {
          // Drain on cancel: caller already aborted, exit fast.
          break;
        }
        if (delta.kind === "text" && delta.text.length > 0) {
          assembled += delta.text;
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: delta.text },
            },
          });
        }
      }
    } catch (err) {
      // AbortError from upstream provider counts as a clean cancellation.
      if (isAbort(err)) {
        log.info("prompt cancelled", { sessionId: session.id });
        // Persist whatever we got so far, so the next turn has context.
        if (assembled) session.history.push({ role: "assistant", content: assembled });
        return { stopReason: "cancelled" };
      }
      log.error("prompt failed", err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (session.abort.signal.aborted) {
      if (assembled) session.history.push({ role: "assistant", content: assembled });
      return { stopReason: "cancelled" };
    }

    session.history.push({ role: "assistant", content: assembled });
    return { stopReason: "end_turn" };
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
}

function extractText(blocks: PromptRequest["prompt"]): string {
  return blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function isAbort(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err && (err as { name: unknown }).name === "AbortError") return true;
  if (err instanceof Error && /aborted/i.test(err.message)) return true;
  return false;
}
