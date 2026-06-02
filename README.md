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
                          │ │ (per peer)   │ │  via @agentclientprotocol/sdk
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
- Streams replies and **routes LLM tool_calls through ACP** — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` — with a multi-step loop bounded at 8 iterations per turn

## Tools the LLM can call

| Tool | ACP method routed to | Client capability required |
|---|---|---|
| `Read(path)` | `fs/read_text_file` | `fs.readTextFile` |
| `Write(path, content)` | `fs/write_text_file` (also tries to read old content for diff) | `fs.writeTextFile` |
| `Edit(path, old_string, new_string)` | `fs/write_text_file` (precise string replacement) | `fs.readTextFile` + `fs.writeTextFile` |
| `Bash(command)` | `terminal/create` + `terminal/wait_for_exit` + `terminal/output` | `terminal: true` |
| `Glob(pattern)` | client-side glob (fast-glob) | — |
| `Grep(pattern)` | client-side ripgrep | — |
| `Skill(name, params)` | client-side skill template rendering | — |

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

# Offline: model selection (setSessionModel) + per-turn token usage report
npx tsx examples/smoke-usage-model.ts

# Offline: custom session-config dropdowns (system_prompt + thinking)
npx tsx examples/smoke-config-options.ts

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
| `INVOX_LOG` | log level: `silent` / `error` / `warn` / `info` / `debug` / `trace` | `info` |
| `INVOX_LOG_FILE` | absolute path to also append logs to (in addition to stderr) | unset |
| `INVOX_LOG_UTC` | `1` to use ISO UTC timestamps instead of local `MM-DD HH:mm:ss.SSS` | unset |
| `INVOX_BASE_URL` | OpenAI-compatible base URL (set both this and API_KEY for real LLM) | — |
| `INVOX_MODEL` | default model name passed to provider (also the prefilled choice in the client's model dropdown) | `gpt-4o-mini` |
| `INVOX_MODELS` | comma-separated list of selectable models advertised to the client (e.g. `gpt-4o-mini,gpt-4o,deepseek-chat`). The default `INVOX_MODEL` is auto-included. | unset (menu = `[INVOX_MODEL]`) |
| `INVOX_API_KEY` | provider API key | — |
| `INVOX_MOCK` | `1` → EchoProvider; `tools` → MockToolProvider; unset → real | unset |
| `INVOX_PERMISSIONS` | `never` (default) / `writes` (gate writes+exec) / `always` (gate all tools) | `never` |
| `INVOX_MAX_ITERATIONS` | max LLM↔tool round-trips per user prompt | `50` |
| `INVOX_SESSION_DIR` | absolute path to store session JSONs (overrides `<cwd>/.invox/sessions`) | unset |
| `INVOX_SESSION_TTL_DAYS` | delete sessions older than N days on first save per cwd. `0` disables. | `30` |
| `INVOX_CONTEXT_WINDOW_<MODEL_ID>` | per-model context window (in tokens) reported via `usage_update`. The MODEL_ID is uppercased with non-alnum characters → `_`. | built-in table |
| `INVOX_CONTEXT_WINDOW_DEFAULT` | fallback context window when the model id isn't in the built-in table | `128000` |
| `INVOX_PROMPT_TEMPLATES_FILE` | absolute path to a JSON file (`SystemPromptDef[]`) overriding the built-in System Prompt menu | unset |

**Provider selection**:
- `INVOX_MOCK=1` → `EchoProvider` (deterministic, offline)
- both `INVOX_API_KEY` and `INVOX_BASE_URL` set → `OpenAIProvider`
- otherwise → `EchoProvider` with a warn log

Logs go to **stderr** unconditionally — stdout is reserved for JSON-RPC framing.

## Model selection & token usage

invox advertises an ACP **model menu** to clients. In Zed, a dropdown next to the input box lists every id from `INVOX_MODELS`; switching the dropdown sends `session/set_model`, which invox honors immediately for the next prompt and persists in the session JSON so reopening the project restores the choice.

```bash
INVOX_BASE_URL=https://api.openai.com/v1 \
INVOX_API_KEY=sk-... \
INVOX_MODEL=gpt-4o-mini \
INVOX_MODELS="gpt-4o-mini,gpt-4o,o1-mini" \
node dist/cli.js
```

The Provider instance is reused across model switches — only the `model` field on each request changes — so swapping models does not rebuild the HTTP client. Different `baseURL`s require restarting invox; one Provider per process for now.

**Token usage** is sourced from the upstream `stream_options.include_usage` final chunk and reported once per turn on **two channels** so the user sees something today and the protocol stays forward-compatible:

1. **`usage_update`** — the official ACP variant from `@agentclientprotocol/sdk@0.23` (`unstable_session_usage`). When Zed has the `acp-beta` feature flag on, this drives the small token-meter chip next to the model dropdown (`Input: 11k / 168k`-style). The wire shape is `{ sessionUpdate: "usage_update", used, size }`.

2. **`agent_thought_chunk`** — visible everywhere as a single line inside Zed's collapsed "Thinking" block:

   ```
   🪙 1234 in / 567 out tokens · 3 call(s) · model=gpt-4o-mini
   ```

   Carries an `_meta: { "invox/usage": {...} }` extension for programmatic clients.

The `size` (context window) used in `usage_update` is looked up from a built-in table covering common models (gpt/claude/qwen/deepseek/gemini/…); override per model with `INVOX_CONTEXT_WINDOW_<MODEL_ID>=<n>` (e.g. `INVOX_CONTEXT_WINDOW_QWEN_QWEN3_CODER_30B=131072`) or globally with `INVOX_CONTEXT_WINDOW_DEFAULT=<n>`. Backends that ignore `stream_options.include_usage` simply don't surface usage — invox stays silent rather than reporting zeros.

## Custom session dropdowns (System Prompt + Thinking)

invox advertises additional ACP `SessionConfigOption` dropdowns that Zed renders next to the model selector. They are stored per-session and persist across loads.

| ID | Category | Values | Effect |
|---|---|---|---|
| `system_prompt` | `system_prompt` (custom) | one of the configured prompt template ids | Replaces the active system message at the next user turn (`history[0]`) |
| `thinking` | `thought_level` | `off` / `low` / `medium` / `high` | Sent as OpenAI `reasoning_effort` on the next request; `off` omits the field |

The System Prompt menu defaults to a built-in trio (`default` / `concise` / `review`). Provide `INVOX_PROMPT_TEMPLATES_FILE` pointing at a JSON file to override:

```jsonc
// templates.json
[
  {
    "id": "default",
    "name": "Default",
    "description": "Helpful coding assistant.",
    "prompt": "You are a coding assistant in Zed. ..."
  },
  {
    "id": "tutor",
    "name": "Patient Tutor",
    "prompt": "You are a patient tutor. Explain step-by-step..."
  }
]
```

Invalid / missing files fall back to the built-in templates with a warn-level log. The first entry of the list is the per-session default; switch via the dropdown to update the live session.

Switching a dropdown is **forward-only** — it does not rewrite past assistant messages. Only the next user turn sees the new prompt / reasoning level. Use a fresh session if you want a clean slate.

## Skills (reusable workflow templates)

The `Skill` tool lets the LLM invoke named prompt templates. Each skill is a `SKILL.md` file inside a named directory.

Skills are loaded from `.claude/skills/` directories:

| Source | Path | Scope |
|---|---|---|
| User-level | `~/.claude/skills/<name>/SKILL.md` | All projects |
| Project-level | `<project>/.claude/skills/<name>/SKILL.md` | This project (overrides user-level) |

### How it works

1. The LLM calls `Skill({ name: "explain", params: { arguments: "function add(a,b){...}" }, description: "Explain code" })`
2. The tool loads `<project>/.claude/skills/explain/SKILL.md`
3. Replaces `$ARGUMENTS` with the provided value
4. Returns the rendered instructions as tool output
5. The LLM follows the instructions using its existing tools (Read, Edit, Bash, etc.)

Calling `Skill({ name: "list" })` returns the catalog of all available skills.

### Creating a skill

```bash
# Project-level
mkdir -p .claude/skills/explain
cat > .claude/skills/explain/SKILL.md << 'EOF'
Explain the following code:

$ARGUMENTS

Provide:
1. Overview
2. Key components
3. Data flow
4. Potential issues
EOF

# Now usable as: Skill({ name: "explain", params: { arguments: "..." } })
```

### Placeholder syntax

| Placeholder | Replaced by | Example |
|---|---|---|
| `$ARGUMENTS` | `params.arguments` (string), or `JSON.stringify(params)` if no `.arguments` key | Claude Code compatible |
| `{{key}}` | `params[key]` verbatim | Named parameter injection |

Example skill using named params:

```markdown
<!-- .claude/skills/review/SKILL.md -->
Review `{{path}}` for bugs.

Check:
- Security
- Performance
- Error handling
```

```
Skill({ name: "review", params: { path: "src/main.ts" } })
```

Skills are cached per cwd. The LLM can call `Skill({ name: "list" })` to discover available skills at any time.

## Design

See [`PLAN.md`](./PLAN.md). It's the source of truth for data structures, stage acceptance criteria, and decision rationale.
