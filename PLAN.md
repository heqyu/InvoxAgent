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

| Claim | Confidence | Verification plan |
|---|---|---|
| ACP method names listed in §0 | High | Verified via official docs |
| `@zed-industries/agent-client-protocol` exposes `AgentSideConnection` | High | Verified via npm + DeepWiki |
| Exact constructor signature (streams vs adapter object) | **Medium** | Read package source / type defs in stage 1 before integrating |
| Whether the package ships a stdio helper | Medium | Verify in stage 1; fall back to manual stdin/stdout adapter if not |
| `openai` SDK supports AbortSignal in stream calls | High | Documented since v4 |
| Web Streams interop with the package's expected stream shape | **Medium** | If package wants Node `Readable`, add a small adapter; do not abandon Web Streams |

Items flagged Medium will be confirmed by reading actual source in the relevant stage, not guessed.

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

## 6. Open questions

None at plan time. New ones get appended here, never inlined into code as TODO.
