# invox

> An [ACP](https://agentclientprotocol.com/) (Agent Client Protocol) compatible agent server with pluggable transports.

**Status:** stage 2 (OpenAI-compatible streaming over stdio). See [`PLAN.md`](./PLAN.md) for the build plan.

## What it is

`invox` is an agent that:

- Speaks Zed's **Agent Client Protocol** (JSON-RPC 2.0) over stdio (and WebSocket in stage 4+)
- Bridges to any **OpenAI-compatible** LLM endpoint (stage 2+)
- Streams replies and routes tool calls through ACP's `fs/*` and permission flows (stage 3+)

## Build & verify

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run build           # emits dist/
npm run dev -- --version  # → "invox v0.0.1"
```

### Synthetic acceptance (stage 1+)

```bash
# Offline: forces EchoProvider (no API key needed)
npx tsx examples/smoke-stdio.ts

# Real LLM: against any OpenAI-compatible endpoint
INVOX_BASE_URL=https://api.openai.com/v1 \
INVOX_MODEL=gpt-4o-mini \
INVOX_API_KEY=sk-... \
npx tsx examples/smoke-openai.ts
```

Both end with `PASS`.

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
| `INVOX_MOCK` | force EchoProvider regardless of other env (testing only) | `0` |

**Provider selection**:
- `INVOX_MOCK=1` → `EchoProvider` (deterministic, offline)
- both `INVOX_API_KEY` and `INVOX_BASE_URL` set → `OpenAIProvider`
- otherwise → `EchoProvider` with a warn log

Logs go to **stderr** unconditionally — stdout is reserved for JSON-RPC framing.

## Design

See [`PLAN.md`](./PLAN.md). It's the source of truth for data structures, stage acceptance criteria, and decision rationale.
