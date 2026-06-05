# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What invox is

An ACP-compatible agent server (Zed's [Agent Client Protocol](https://agentclientprotocol.com/), JSON-RPC 2.0) that bridges any OpenAI-compatible LLM endpoint to a code editor. Speaks stdio (default, used by Zed) and WebSocket (browsers / custom clients) on the same process.

### Source-of-truth trio

| 文件 | 角色 | 何时读 / 何时改 |
|---|---|---|
| `PLAN.md` | **宪法**：数据结构、stage 验收、不可逾越的红线（Rule 2 + 5） | 改协议表面 / 数据结构 / 新 stage 时先改这里 |
| `PROGRESS.md` | **滚动施工图**：当前 sprint 的 Doing/Done/Backlog、Phase A–F 路线、Known Issues | 任务流转、新增 backlog、勾掉 Done 时改这里 |
| `DIARY.md` | **工作日志**：决策原因、教训、复盘（追加写） | 完成一个 Phase / 踩坑 / sprint 收尾时追加 |

冲突顺序：**PLAN > PROGRESS > 代码**。代码与 PLAN 冲突 → 先改 PLAN；与 PROGRESS 冲突 → 改 PROGRESS。新功能开工前先看 `PROGRESS.md` 的 Doing/Phase 优先级。

## Commands

```bash
npm run dev -- --version   # tsx-driven dev run; no build step needed
npm run typecheck          # tsc --noEmit
npm run build              # emits dist/
npm start                  # node dist/cli.js
npm run restart            # bash scripts/dev-restart.sh — see "Dev loop with Zed"
```

### Smoke tests (offline acceptance harnesses)

Each `examples/smoke-*.ts` ends with `PASS` or throws. Run via `npx tsx examples/<file>.ts`. Real-LLM variant (`smoke-openai.ts`) needs `INVOX_BASE_URL`, `INVOX_MODEL`, `INVOX_API_KEY` in env. Stages 1, 4 also require Zed-direct verification per PLAN.md §7 — the synthetic harness alone does NOT count as VERIFIED.

There is no unit-test framework. New behavioral checks become a new `smoke-*.ts` harness.

### Dev loop with Zed

Zed launches invox as `node --import tsx src/cli.ts`, so source changes don't require `npm run build` — but Zed keeps the spawned process alive across prompts. **`npm run restart` kills the running invox so Zed re-spawns it on the next prompt.** Don't `kill -9` it directly: Zed will mark the agent broken and refuse to relaunch until Zed itself restarts. The script handles this carefully on Windows (taskkill graceful first, `/F` only if needed).

For interactive debugging see `DEBUGGING.md` — short version: launch with `--inspect=127.0.0.1:9229` from Zed's `agent_servers` config, then attach VS Code or Chrome DevTools.

## Architecture

```
Transport (stdio | WebSocket)         one transport.start() registers onPeer
        │
        ▼
PeerStream  ──→  AgentSideConnection ──→ InvoxAgent     one InvoxAgent per peer
                                              │         (stdio: 1 ever; ws: 1 per client)
                                              │
                          sessions: Map<id, Session>     created by session/new or session/load
                                              │
                                              ▼
                  prompt() ── runOneIteration() ──── up to INVOX_MAX_ITERATIONS=50
                       │
                       ├── provider.stream() → text + tool_calls + finish
                       │
                       └── for each tool_call:
                              executeTool() → permission gate → tool.execute()
                              push tool result to history → continue loop
```

### Decisions worth knowing before editing

- **`Session.history` is OpenAI-shape, not ACP-shape.** Translation happens once per direction at the edges (`buildUserContent` ACP→OAI in `agent.ts`; chunks emitted as ACP `session/update` notifications). Don't introduce a third shape.
- **Per-connection isolation.** `cli.ts` constructs a fresh `InvoxAgent` for every peer via the `AgentSideConnection` factory callback. Multiple WS clients each get their own `sessions` map; nothing is shared.
- **stdout is sacred.** The stdio transport owns it for JSON-RPC framing. All logs go through `src/log.ts` → stderr (and optionally `INVOX_LOG_FILE`). Never `console.log`. Never write to fd 1 from anywhere except the ACP package's stdio writer.
- **Transport abstraction is `PeerStream` (Web Streams of bytes for stdio; `Stream` direct for WS).** Each transport adapts to its own framing. **Don't share frame logic between transports** — stdio is line-delimited NDJSON, WS is one-frame-per-message. `transports/types.ts` is the contract.
- **Session persistence is automatic and per-cwd.** Every `prompt()` call ends with `persist()` → `<cwd>/.invox/sessions/<id>.json` (overridable via `INVOX_SESSION_DIR`). `loadSession` replays history back to the client as `session/update` notifications so Zed's UI reflects past turns. TTL prune (`INVOX_SESSION_TTL_DAYS`, default 30) runs once per cwd on first save. `Session.selectedModel` (set via `setSessionModel`) is part of the snapshot — reopening Zed against the same project restores the dropdown to the user's last choice.
- **Model selection is per-session, Provider instance is shared.** `INVOX_MODELS` (comma-separated) defines the menu; the Provider reads `req.model` per call and falls back to its constructor default if unset. Adding a *different* baseURL/apiKey still requires a process restart — only the model id is hot-swappable.
- **Token usage** is gathered via OpenAI's `stream_options.include_usage` final chunk → `LLMDelta { kind: "usage" }` → accumulated in `Session.turnUsage` → reported once per turn on **two channels**: (a) `usage_update` (ACP 0.13 schema's `unstable_session_usage` variant — drives Zed's token-meter chip when `acp-beta` flag is on; sent via a typed-cast because npm 0.4.5 doesn't expose it yet) and (b) `agent_thought_chunk` carrying a 🪙 line + `_meta.invox/usage` (visible everywhere). The `size` field on `usage_update` is looked up via `contextWindowFor(modelId)` — a small substring table with `INVOX_CONTEXT_WINDOW_<MODEL_ID>` and `INVOX_CONTEXT_WINDOW_DEFAULT` env overrides. Both channels are silent if the upstream provider didn't return usage (e.g. EchoProvider, or self-hosted backends that drop `include_usage`).
- **Session config dropdowns** (`SessionConfigOption`, ACP stable as of `@agentclientprotocol/sdk@0.23`) are the first-class way to expose any per-session knob in Zed's bottom toolbar — preferred over new env vars when the user should be able to flip the setting mid-session. Today invox advertises two: `system_prompt` (replaces `Session.history[0]` content; templates from `INVOX_PROMPT_TEMPLATES_FILE` or built-in default/concise/review) and `thinking` (off / low / medium / high → OpenAI `reasoning_effort`). Both persist via `PersistedSession.configValues`. The handler is `setSessionConfigOption` — distinct from the unstable `setSessionMode` / `unstable_setSessionModel`. Switching is **forward-only**: the new prompt or reasoning level affects the next user turn, not retrofits old assistant messages.

### Tool subsystem (`src/tools/`)

Tools are pluggable via the registry pattern:

1. Implement `Tool` from `tools/types.ts` in a new `src/tools/<name>.ts`.
2. Add the export to `TOOLS` in `tools/registry.ts` — that's the only wiring step. The router dispatches by `name`.

Each `Tool` declares a `tier: "read" | "write" | "execute"`. The router's permission gate (`tools/permissions.ts`) consults `INVOX_PERMISSIONS`:
- `never` (default) — run everything; the agent trusts the LLM
- `writes` — gate write+execute tiers via `session/request_permission`
- `always` — gate every tool

`SessionToolState` (`readPaths` set + `FileCache`) is created per session and passed to every tool execution. **`Edit` enforces read-before-edit** by checking `readPaths`; that's the safety net against blind LLM edits. Cache invalidation lives in `cache.ts` — `Write`/`Edit` mutate the entry; we deliberately do **not** detect external mutations within a session.

### LLM provider selection

`pickProvider()` in `cli.ts` chooses based on env:

| Env | Provider |
|---|---|
| `INVOX_MOCK=tools` | `MockToolProvider` (offline, scripted tool calls — used by `smoke-tools.ts`) |
| `INVOX_MOCK=1` | `EchoProvider` (offline, deterministic — used by `smoke-stdio.ts` etc.) |
| both `INVOX_API_KEY` and `INVOX_BASE_URL` | `OpenAIProvider` |
| neither | `EchoProvider` with a warn |

`LLMProvider.stream()` yields a discriminated union (`text` | `tool_call` | `finish`). The OpenAI provider must accumulate `function.arguments` per `tool_calls[index]` separately — naive concat misses the index, listed in PLAN.md §3 as a known pitfall.

### ACP protocol notes

- `PROTOCOL_VERSION = 1` (re-exported from the package).
- `session/update` is a **notification**, not a request. Use `conn.sessionUpdate(...)`; never `await` it as a request — would hang.
- `Agent` interface required methods: `initialize`, `newSession`, `authenticate`, `prompt`, `cancel`. Optional: `loadSession`, `setSessionMode`, `setSessionModel`, `extMethod`, `extNotification`.
- `PromptResponse.stopReason` literals: `"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"`. Map outcomes to one of these in `prompt()`.

## Repository conventions

- **ESM only** (`"type": "module"`, `NodeNext`). Import paths must end in `.js` even though sources are `.ts` — TypeScript with `NodeNext` resolves them.
- **One commit per stage** with `[VERIFIED]` tag (PLAN.md Rule 5). If a stage breaks, `git reset --hard <last-VERIFIED>` and redo; never patch on top.
- The Zed acceptance addendum (PLAN.md §7) applies to any change that touches the protocol surface: synthetic harness PASS **and** Zed direct-connect must both work before claiming VERIFIED.
- Logging levels via `INVOX_LOG`: `silent | error | warn | info | debug | trace`. Never enable `trace` in shared environments — it dumps full LLM payloads.
- Module filtering via `INVOX_LOG_MODULE`: `*` (all), `[]` (none), `agent,llm` (whitelist), `*,-agent` (blacklist). Default `*`. Use `createLogger("name")` per-file; format is `date [level] [module] msg`.
