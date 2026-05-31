# Invox — Build Plan

> Externalized plan per self-constrained-build Rule 2. This file is the contract between past-me and future-me. **If anything in code contradicts this file, this file wins until amended here.**

## 0. Categorization

This is the intersection of two known categories:

- **Cat A — JSON-RPC server with pluggable transport** (LSP-style; well-trodden)
- **Cat B — Streaming LLM gateway with tool routing** (OpenAI-compatible upstream)

Generic skeleton:

```
[Transport]    stdio | WebSocket | (HTTP-SSE later)
     ↓ frames JSON-RPC 2.0
[ACP layer]    @zed-industries/agent-client-protocol → AgentSideConnection
     ↓ protocol → agent ops
[Agent core]   session manager, prompt loop, tool dispatch
     ↓ delegates completion
[Provider]     openai SDK with custom baseURL
     ↓ chunks + tool_calls
[Tool router]  LLM tool_call ↔ ACP fs/* | terminal/* | request_permission
```

## 1. Core Data Structures (frozen here; change requires updating this file first)

```ts
// One running invox process
interface AgentServer {
  transports: Transport[];                      // configured at startup
  newAgent(conn: AgentSideConnection): Agent;   // per-connection agent
}

// One ACP connection (one stdio stream OR one WS client)
interface Agent {
  sessions: Map<SessionId, Session>;
  clientCaps: ClientCapabilities;               // captured during initialize
}

// One session (one session/new call → one)
interface Session {
  id: SessionId;
  cwd: string;
  history: ChatMessage[];                       // OpenAI shape, NOT translated to ACP
  modelConfig: { baseURL: string; model: string; apiKey: string };
  abort?: AbortController;                      // set during prompt, cleared at end
}

// Transport abstraction — the line that lets stdio/ws coexist
interface Transport {
  readonly name: 'stdio' | 'ws';
  start(onPeer: (peer: PeerStream) => void): Promise<void>;
  stop(): Promise<void>;
}

// PeerStream: byte streams in Web Streams shape (Node 24 native, browser-portable)
interface PeerStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
```

### Why these shapes (decision log)

| Decision | Choice | Rationale |
|---|---|---|
| `Session.history` shape | OpenAI message array | Provider is OAI-compatible; ACP is just IO. Storing in OAI shape means one translation per direction (ACP→OAI on prompt arrival; OAI→ACP on chunk emit), not bidirectional. |
| Transport abstraction | Web Streams (`ReadableStream<Uint8Array>`/`WritableStream<Uint8Array>`) | Native to both Node 24 and browsers. ACP package consumes byte streams directly. Adding HTTP-SSE later = new file, not refactor. |
| Per-connection vs global agent | Per-connection (`Agent` instance per stream) | Multiple WS clients = multiple isolated session maps. Stdio = one agent (only one peer ever). |
| Module system | ESM | Node 24 native, ACP package is ESM. Top-level `await` available. |
| OpenAI client | Official `openai` SDK | "OpenAI-compatible" → direct match. baseURL override is first-class. tool_calls + streaming are typed. |
| Logging | `console.error` only, gated by `INVOX_LOG` | stdio is sacred for JSON-RPC; never touch stdout. |

## 2. Stages — every stage runnable, one commit per stage

| # | Stage | Acceptance (external evidence) | Commit message |
|---|---|---|---|
| 0 | Repo skeleton, hello CLI | `npm run dev` prints `invox v0.0.1` to stderr, exits 0 | `stage 0: repo skeleton [VERIFIED]` |
| 1 | ACP over stdio (echo) | `examples/smoke-stdio.ts` spawns invox, gets streamed `session/update` chunks | `stage 1: acp over stdio [VERIFIED]` |
| 2 | OpenAI-compatible LLM | Real endpoint streams a real reply | `stage 2: openai streaming [VERIFIED]` |
| 3 | Tool calling | "read this file → summarize" round-trips | `stage 3: tool calling [VERIFIED]` |
| 4 | WebSocket transport | `examples/smoke-ws.ts` does end-to-end over WS | `stage 4: ws transport [VERIFIED]` |
| 5 | Cancellation, error mapping, README | Ctrl+C mid-stream halts upstream LLM; bad key → structured error | `stage 5: polish [VERIFIED]` |

**Hard rule (self-constrained-build Rule 5):** no stage advances without that exact external evidence. If a stage breaks, `git reset --hard <last-VERIFIED>` and redo, never patch on top.

## 3. Pitfalls — listed upfront so we don't step in them

| Pitfall | Symptom | Prevention |
|---|---|---|
| stdout used for logs | JSON-RPC stream corrupted by stray `console.log` | All logs to stderr. ESLint rule `no-console` with `"allow": ["error", "warn"]`. |
| Windows stdio buffering | First message never arrives | Don't pipe through line-buffering tools; ACP package handles flushing. |
| Sharing a parser across transports | stdio (line-delimited) ≠ WS (per-message) → corruption | Each transport adapts to common `PeerStream`; **never share frame logic**. |
| LLM tool_call streaming arg deltas | Naive concat misses indices | Track `tool_calls[index]` separately; accumulate `function.arguments` per index. |
| `session/update` is a notification, not request | Awaiting it hangs | Use the package's `sessionUpdate(...)` notify path; never `request`. |
| Tool perms not asked | Agent silently writes user files | All destructive ops gate on `session/request_permission`; deny → throw. |
| Cancellation doesn't reach LLM | User stops, provider keeps burning tokens | Pass `AbortController.signal` into the openai SDK call; abort on `session/cancel`. |
| WS CORS / origin spoofing | Browser refuses to connect, or any page connects | Bind `127.0.0.1` by default; allow-list configurable. |
| Promise leaks on stream end | Hanging chunk readers after disconnect | All async iterators wrapped in try/finally; abort on transport close. |
| Mixed-stage commits | Can't bisect | One commit per stage with `[VERIFIED]` tag. No exceptions. |

## 4. Confidence ledger (self-constrained-build Rule 6)

| Claim | Initial | Resolved | Source |
|---|---|---|---|
| ACP method names listed in §0 | High | ✅ | docs |
| Package exposes `AgentSideConnection` | High | ✅ | npm + types on disk |
| Constructor signature | **Medium** | ✅ `new AgentSideConnection(toAgent: (conn) => Agent, stream: Stream)` — factory pattern, agent created with conn handle | `dist/acp.d.ts:30` |
| Stdio helper shipped | Medium | ✅ `acp.ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream` | `dist/stream.d.ts:24` |
| `openai` SDK supports AbortSignal | High | (confirms at stage 2) | docs |
| Web Streams interop | **Medium** | ✅ Package consumes `WritableStream<Uint8Array>` / `ReadableStream<Uint8Array>` directly. PLAN §1 transport abstraction matches. | `dist/stream.d.ts` |
| `Agent` interface required methods | (new) | ✅ `initialize`, `newSession`, `authenticate`, `prompt`, `cancel`. Optional: `loadSession`, `setSessionMode`, `setSessionModel`, `extMethod`, `extNotification` | `dist/acp.d.ts:479` |
| `PROTOCOL_VERSION` constant | (new) | ✅ exported as `1` | `dist/schema.d.ts:22` |
| `PromptResponse.stopReason` literals | (new) | ✅ `"end_turn" \| "max_tokens" \| "max_turn_requests" \| "refusal" \| "cancelled"` | `dist/schema.d.ts:1391` |
| `SessionNotification.update` discriminator | (new) | ✅ `sessionUpdate` field; chunk variants use `agent_message_chunk` etc. with a `ContentBlock` | `dist/schema.d.ts:1418` |

## 5. Repo layout

```
invox/
  PLAN.md                 ← this file
  README.md
  package.json
  tsconfig.json
  .gitignore
  src/
    cli.ts                ← entry; arg parsing, transport selection
    agent/
      agent.ts            ← Agent class (per-connection)
      session.ts          ← Session class
    transports/
      stdio.ts
      websocket.ts
    llm/
      openai.ts           ← provider adapter
    tools/
      router.ts           ← LLM tool_call ↔ ACP bridge
    log.ts                ← stderr-only logger
  examples/
    smoke-stdio.ts        ← stage 1+ acceptance harness
    smoke-ws.ts           ← stage 4 acceptance harness
```

## 6. Open questions / deferred items

- **Package rename** — `@zed-industries/agent-client-protocol@0.4.5` is deprecated in favor of `@agentclientprotocol/sdk`. Deferred to stage 5 polish: API is identical (rename only) and the deprecated version still works. Zed itself doesn't care which npm package the agent depends on — it just JSON-RPCs. Risk: low. Trigger to escalate: a security advisory on the old name, or any API drift on the new name.

## 7. Zed direct-connect acceptance (added after stage 0)

**User requirement:** every milestone where the protocol is exercised must be **directly verifiable from Zed**, not just from synthetic harnesses.

Zed launches an external agent via its `agent_servers` setting in `~/.config/zed/settings.json` (or `%APPDATA%/Zed/settings.json` on Windows):

```json
{
  "agent_servers": {
    "invox": {
      "command": "node",
      "args": ["G:/OhMyProjs/InvoxAgent/dist/cli.js"]
    }
  }
}
```

For dev iteration without rebuilding:

```json
{
  "agent_servers": {
    "invox-dev": {
      "command": "node",
      "args": ["--import", "tsx", "G:/OhMyProjs/InvoxAgent/src/cli.ts"]
    }
  }
}
```

**Acceptance addendum to every protocol-exercising stage (1, 2, 3, 4, 5):**

> The synthetic harness (`smoke-stdio.ts` / `smoke-ws.ts`) passes **AND** opening Zed's agent panel, selecting `invox`, sending a prompt produces the expected behavior. Both must be VERIFIED before the stage commit.

Stage 4's WebSocket transport is browser/custom-client-only and not Zed-exercised — Zed acceptance for stage 4 = "stdio still works alongside the new WS transport, regression-free".
