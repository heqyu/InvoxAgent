# invox

> An [ACP](https://agentclientprotocol.com/) (Agent Client Protocol) compatible agent server with pluggable transports.

**Status:** v0.0.1 — five stages landed (stdio + WebSocket transports, OpenAI streaming, tool calling, cancellation). See [`PLAN.md`](./PLAN.md) for the build plan.

## Architecture

```
       ┌────────────┐                           ┌─────────────────┐
       │   Zed      │── stdio ─┐         ┌───── │ Browser /       │
       └────────────┘          │         │ ws   │ custom WS client│
                               ▼         ▼      └─────────────────┘
                          ┌──────────────────┐
                          │  invox process   │
                          │ ┌──────────────┐ │
                          │ │ transports/  │ │  one peer = one connection
                          │ │ stdio  ws    │ │
                          │ └──────┬───────┘ │
                          │        │         │
                          │ ┌──────▼───────┐ │
                          │ │AgentSideConn │ │  ACP / JSON-RPC 2.0
                          │ │ (per peer)   │ │  via @zed-industries/agent-client-protocol
                          │ └──────┬───────┘ │
                          │        │         │
                          │ ┌──────▼───────┐ │
                          │ │ InvoxAgent   │ │  multi-step loop, MAX_ITER=8
                          │ │ + sessions{} │ │
                          │ └──┬────────┬──┘ │
                          │    │        │    │
                          │ ┌──▼──┐ ┌───▼──┐ │
                          │ │ LLM │ │tools/│ │  fs/* + terminal/* via ACP client methods
                          │ │ prov│ │router│ │  (fs.readTextFile, writeTextFile, terminal/*)
                          │ └──┬──┘ └──────┘ │
                          └────┼─────────────┘
                               ▼
                       ┌────────────────┐
                       │ OpenAI-compat  │   any baseURL: OpenAI / DeepSeek /
                       │   endpoint     │   Together / vLLM / Ollama / LM Studio
                       └────────────────┘
```

## What it is

`invox` is an agent that:

- Speaks Zed's **Agent Client Protocol** (JSON-RPC 2.0) over stdio (and WebSocket in stage 4+)
- Bridges to any **OpenAI-compatible** LLM endpoint
- Streams replies and **routes LLM tool_calls through ACP** — `read_file`, `write_file`, `bash` — with a multi-step loop bounded at 8 iterations per turn

## Tools the LLM can call

| Tool | ACP method routed to | Client capability required |
|---|---|---|
| `read_file(path)` | `fs/read_text_file` | `fs.readTextFile` |
| `write_file(path, content)` | `fs/write_text_file` (also tries to read old content for diff) | `fs.writeTextFile` |
| `bash(command)` | `terminal/create` + `terminal/wait_for_exit` + `terminal/output` | `terminal: true` |

Permission policy for v1: **never ask** — the agent trusts the LLM and runs tools directly. (Stage 5 polish may add an env-knob for stricter policies.)

## Build & verify

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run build           # emits dist/
npm run dev -- --version  # → "invox v0.0.1"
```

### Synthetic acceptance

```bash
# Offline: forces EchoProvider (no API key needed) — stdio transport
npx tsx examples/smoke-stdio.ts

# Offline: tool-calling end-to-end with MockToolProvider — stdio transport
npx tsx examples/smoke-tools.ts

# Offline: full ACP over WebSocket — confirms the second transport
npx tsx examples/smoke-ws.ts

# Offline: session/cancel halts an in-flight stream
npx tsx examples/smoke-cancel.ts

# Real LLM: against any OpenAI-compatible endpoint
INVOX_BASE_URL=https://api.openai.com/v1 \
INVOX_MODEL=gpt-4o-mini \
INVOX_API_KEY=sk-... \
npx tsx examples/smoke-openai.ts
```

All five end with `PASS`.

### Connect from a browser / custom client (WebSocket)

Start invox listening for WebSocket clients:

```bash
node dist/cli.js --ws --port 9744 --host 127.0.0.1
# (multiple transports allowed: --stdio --ws  binds both)
```

**Wire format:** each WebSocket text frame is exactly **one JSON-RPC 2.0 envelope** — request, response, or notification. No NDJSON wrapping; WS already frames messages.

Minimal browser snippet:

```javascript
const ws = new WebSocket("ws://127.0.0.1:9744");
ws.onmessage = (ev) => console.log("← agent:", JSON.parse(ev.data));
ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: { fs: {} } },
  }));
};
```

Multiple browsers can connect simultaneously — each gets its own session map.

### Connect from Zed

Add this to your Zed `settings.json` (`%APPDATA%/Zed/settings.json` on Windows, `~/.config/zed/settings.json` on Linux/macOS):

```jsonc
{
  "agent_servers": {
    "invox": {
      "command": "node",
      "args": ["G:/OhMyProjs/InvoxAgent/dist/cli.js"]
    }
  }
}
```

Or for live development without rebuilding:

```jsonc
{
  "agent_servers": {
    "invox-dev": {
      "command": "node",
      "args": ["--import", "tsx", "G:/OhMyProjs/InvoxAgent/src/cli.ts"]
    }
  }
}
```

Then in Zed: open the agent panel, pick **invox**, send a prompt. Stage 1 echoes your text back, streamed chunk-by-chunk.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `INVOX_LOG` | log level: `silent` / `error` / `warn` / `info` / `debug` | `info` |
| `INVOX_BASE_URL` | OpenAI-compatible base URL (set both this and API_KEY for real LLM) | — |
| `INVOX_MODEL` | model name passed to provider | `gpt-4o-mini` |
| `INVOX_API_KEY` | provider API key | — |
| `INVOX_MOCK` | `1` → EchoProvider; `tools` → MockToolProvider; unset → real | unset |
| `INVOX_PERMISSIONS` | `never` (default) / `writes` (gate writes+exec) / `always` (gate all tools) | `never` |
| `INVOX_PERMISSIONS` | `never` (default) / `writes` (gate writes+exec) / `always` (gate all tools) | `never` |

**Provider selection**:
- `INVOX_MOCK=1` → `EchoProvider` (deterministic, offline)
- both `INVOX_API_KEY` and `INVOX_BASE_URL` set → `OpenAIProvider`
- otherwise → `EchoProvider` with a warn log

Logs go to **stderr** unconditionally — stdout is reserved for JSON-RPC framing.

## Design

See [`PLAN.md`](./PLAN.md). It's the source of truth for data structures, stage acceptance criteria, and decision rationale.
