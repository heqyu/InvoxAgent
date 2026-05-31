# invox

> An [ACP](https://agentclientprotocol.com/) (Agent Client Protocol) compatible agent server with pluggable transports.

**Status:** under active development. See [`PLAN.md`](./PLAN.md) for the build plan and current stage.

## What it is

`invox` is an agent that:

- Speaks Zed's **Agent Client Protocol** (JSON-RPC 2.0)
- Exposes itself over multiple transports — **stdio** (for Zed) and **WebSocket** (for browsers / custom clients)
- Bridges to any **OpenAI-compatible** LLM endpoint
- Streams replies and routes tool calls through ACP's `fs/*` and permission flows

## Quick start (will grow per stage)

```bash
npm install
npm run dev    # stage 0: prints version
```

## Design

See [`PLAN.md`](./PLAN.md). It's the source of truth for data structures, stage acceptance criteria, and decision rationale.
