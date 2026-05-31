# invox

> An [ACP](https://agentclientprotocol.com/) (Agent Client Protocol) compatible agent server with pluggable transports.

**Status:** stage 1 (echo agent over stdio). See [`PLAN.md`](./PLAN.md) for the build plan.

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

### Synthetic acceptance (stage 1)

```bash
npx tsx examples/smoke-stdio.ts
```

Expected output ends with `[smoke] PASS` and shows ~7 streamed chunks.

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
| `INVOX_BASE_URL` | OpenAI-compatible base URL (stage 2+) | — |
| `INVOX_MODEL` | model name passed to provider (stage 2+) | — |
| `INVOX_API_KEY` | provider API key (stage 2+) | — |

Logs go to **stderr** unconditionally — stdout is reserved for JSON-RPC framing.

## Design

See [`PLAN.md`](./PLAN.md). It's the source of truth for data structures, stage acceptance criteria, and decision rationale.
