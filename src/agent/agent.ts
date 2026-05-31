// InvoxAgent: implements the ACP `Agent` interface.
//
// Stage 1 scope (echo agent):
//   - initialize: advertise minimal capabilities, return PROTOCOL_VERSION
//   - newSession: mint a uuid sessionId, store cwd
//   - authenticate: accept (no auth required for v1)
//   - prompt: stream a hardcoded reply chunk-by-chunk via conn.sessionUpdate,
//             then return stopReason="end_turn"
//   - cancel: flip an AbortController flag (no real upstream to cancel yet —
//             stages 2+ will gate the LLM call on this signal)
//   - loadSession / setSessionMode / setSessionModel: omitted (optional in spec)
//
// CHOICE: state lives on this instance, scoped to one connection.
// One connection = one InvoxAgent. Multiple WS clients in stage 4 = multiple
// InvoxAgent instances, each with isolated session maps.

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

interface Session {
  id: string;
  cwd: string;
  abort: AbortController;
}

export class InvoxAgent implements Agent {
  readonly conn: AgentSideConnection;
  private clientCaps: ClientCapabilities = {};
  private sessions = new Map<string, Session>();

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCaps = params.clientCapabilities ?? {};
    log.info("initialize", {
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
      authMethods: [], // no auth: upstream LLM creds come from env
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // No auth methods advertised → this should never be called by a spec-compliant client.
    // Return empty success to be charitable.
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      cwd: params.cwd,
      abort: new AbortController(),
    });
    log.info("session created", { id, cwd: params.cwd });
    return { sessionId: id };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      // Per JSON-RPC convention; the package will translate thrown Errors.
      throw new Error(`unknown sessionId: ${params.sessionId}`);
    }

    const userText = extractText(params.prompt);
    log.info("prompt received", { sessionId: session.id, userText });

    // Stage 1 echo: stream a fixed reply chunked across multiple updates,
    // so the smoke test can verify streaming actually works (not just one big blob).
    const reply = `invox echo: you said "${userText}". streaming works ✓`;
    const chunks = chunkString(reply, 8);

    for (const chunk of chunks) {
      if (session.abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
      // small artificial delay so streaming is observable end-to-end
      await sleep(20);
    }

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
    // Stage 2+: this signal will be passed into the OpenAI SDK call.
  }
}

function extractText(blocks: PromptRequest["prompt"]): string {
  // v1: only "text" content blocks. Other types (image/audio/resource_link/resource)
  // are ignored — capabilities advertise text-only.
  return blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
