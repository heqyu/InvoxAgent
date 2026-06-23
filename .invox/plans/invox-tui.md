# InvoxTUI — Standalone ACP Client TUI via WebSocket

## Goal

Build a standalone terminal UI (`invox-tui`) that connects to an Invox ACP agent server over WebSocket, implements the ACP `Client` interface, and provides an interactive chat experience with streaming output, tool call visualization, permission handling, and config/model selection.

---

## Findings

### ACP SDK Client API (from `@agentclientprotocol/sdk@0.25.0`)

- **`ClientSideConnection`** wraps a `Stream` and implements the `Agent` interface (i.e., it proxies *client → agent* requests).
- **Constructor**: `new ClientSideConnection(toClient: (agent: Agent) => Client, stream: Stream)` — the factory receives the Agent proxy so the Client can call agent methods if needed, but typically the client uses `connection.*` directly.
- **`Stream`** = `{ readable: ReadableStream<AnyMessage>, writable: WritableStream<AnyMessage> }` — `AnyMessage` is JSON-RPC 2.0 request/response/notification objects.
- **`Client` interface** (must be implemented by TUI):
  - `sessionUpdate(params: SessionNotification): Promise<void>` — **required**, receives streaming agent output
  - `requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>` — **required**, handle permission prompts
  - `writeTextFile?(...)` / `readTextFile?(...)` — optional FS capabilities
  - `createTerminal?(...)` / `terminalOutput?(...)` / `releaseTerminal?(...)` / `waitForTerminalExit?(...)` / `killTerminal?(...)` — optional terminal capabilities

- **`SessionUpdate` union** (12 variants the TUI must handle):
  - `agent_message_chunk` — text streaming (ContentChunk with `{type:"text",text}`)
  - `agent_thought_chunk` — thinking/reasoning text
  - `user_message_chunk` — echoed user content
  - `tool_call` — new tool invocation (title, kind, status, rawInput, locations)
  - `tool_call_update` — tool progress/completion (status, content, title)
  - `plan` / `plan_update` / `plan_removed` — agent planning
  - `available_commands_update` — slash commands
  - `current_mode_update` — mode changes
  - `config_option_update` — config changes
  - `session_info_update` — title/metadata updates
  - `usage_update` — token usage (used, size, cost)

- **`SessionConfigOption`**: returned by `newSession`/`loadSession` response, has `id`, `name`, `category`, `type` ("select"|"boolean"), `currentValue`, `options[]`. Categories: `"model"`, `"thought_level"`, `"agent"`, `"system_prompt"`, or custom.

- **`PROTOCOL_VERSION`** = `1` (from `schema/index.js:48`)

### WebSocket Transport (from `src/transports/websocket.ts:91-154`)

- Invox's server-side `wsToStream()` creates a `Stream` from a `WebSocket` server socket.
- Each WS text message = exactly one JSON-RPC 2.0 frame (no NDJSON delimiter).
- The TUI needs the **reverse**: connect as a WS *client*, then bridge to `Stream`.
- Key pattern: `ReadableStream<AnyMessage>` listens on `ws.on("message")`, `WritableStream<AnyMessage>` calls `ws.send(JSON.stringify(msg))`.
- The `ws` npm package works identically for client-side connections.

### Invox Agent Server Details

- **Default WS port**: `9999` (configurable via `--port`), bind `127.0.0.1` (configurable via `--host`) — `src/cli.ts:68-70`
- **Session creation**: `newSession({ cwd, mcpServers })` returns `{ sessionId, configOptions }` — `src/agent/agent.ts:221-308`
- **Prompt**: `prompt({ sessionId, prompt: [{type:"text", text}] })` returns `{ stopReason, usage? }` — `src/agent/agent.ts:610-809`
- **Cancel**: `cancel({})` is a notification (no response) — `src/agent/agent.ts:811-822`
- **Config option**: `setSessionConfigOption({ sessionId, configId, value })` returns `{ configOptions }` — `src/agent/agent.ts:522-608`
- **Permission flow**: agent calls `requestPermission()` on client with `toolCall` + `options[]` — `src/tools/permissions.ts:23-50`
- **Permission policy**: controlled by `INVOX_PERMISSIONS` env: `"never"` (default), `"writes"`, `"always"` — `src/cli.ts:288-293`

---

## Proposed Changes

All changes are in a **new project** at `G:\OhMyProjs\InvoxTUI`.

### Phase 0: Project Scaffolding

#### `package.json` — New file (M)
```json
{
  "name": "invox-tui",
  "version": "0.1.0",
  "type": "module",
  "bin": { "invox-tui": "./dist/cli.js" },
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "build": "tsc",
    "start": "node dist/cli.js"
  }
}
```

**Dependencies:**
- `@agentclientprotocol/sdk` — ACP client SDK
- `ink` — React-based terminal UI framework
- `react` — Required by ink
- `ws` — WebSocket client
- `@types/ws` — WS types
- `cli-highlight` — Syntax highlighting for code blocks
- `marked` — Markdown parser (for rendering agent output)
- `marked-terminal` — Terminal renderer for marked
- `yargs` or `meow` — CLI arg parsing
- `chalk` — Terminal colors (ink uses it internally, but useful standalone)

**Dev dependencies:**
- `typescript`, `tsx`, `@types/react`, `@types/node`

#### `tsconfig.json` — New file (S)
- `jsx: "react-jsx"`, `module: "NodeNext"`, `target: "ES2022"`, `strict: true`

#### `src/cli.tsx` — New file (M)
- Entry point: parse `--ws ws://host:port` arg (default `ws://127.0.0.1:9999`)
- Parse optional `--cwd` (default `process.cwd()`)
- Create WebSocket, bridge to Stream, create `ClientSideConnection`
- Run `initialize()` + `newSession()`
- Render `<App />` with ink, passing connection + sessionId as props

### Phase 1: WebSocket ↔ Stream Bridge

#### `src/acp/ws-stream.ts` — New file (M)
The reverse of Invox's `wsToStream()`. Creates an ACP `Stream` from a WS client connection:

```typescript
import WebSocket from "ws";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export function wsClientToStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const msg = JSON.parse(text) as AnyMessage;
        controller.enqueue(msg);
      });
      ws.on("close", () => { try { controller.close(); } catch {} });
      ws.on("error", (err) => { try { controller.error(err); } catch {} });
    },
    cancel() { try { ws.close(); } catch {} },
  });

  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      return new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify(msg), (err) => {
          if (err) reject(err); else resolve();
        });
      });
    },
    close() { try { ws.close(1000); } catch {} },
    abort() { try { ws.terminate(); } catch {} },
  });

  return { readable, writable };
}
```

**Evidence**: Pattern directly mirrors `src/transports/websocket.ts:91-154` in Invox, with the direction reversed (client connects, server accepts).

#### `src/acp/connection.ts` — New file (M)
Orchestrates the full connection lifecycle:
- Accept WS URL, create WebSocket, wrap in Stream
- Instantiate `ClientSideConnection` with the `Client` implementation factory
- Expose `connection` (Agent proxy), `sessionId`, `configOptions`
- Handle reconnection (future)

### Phase 2: Client Implementation (ACP Client Interface)

#### `src/acp/tui-client.ts` — New file (L)
Implements the `Client` interface. This is the bridge between ACP events and the Ink UI state.

```typescript
import type { Client, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export class TuiClient implements Client {
  private store: SessionStore; // reactive state store

  constructor(store: SessionStore) {
    this.store = store;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.store.appendAgentMessage(update.content);
        break;
      case "agent_thought_chunk":
        this.store.appendThought(update.content);
        break;
      case "tool_call":
        this.store.addToolCall(update);
        break;
      case "tool_call_update":
        this.store.updateToolCall(update);
        break;
      case "plan":
      case "plan_update":
      case "plan_removed":
        this.store.updatePlan(update);
        break;
      case "usage_update":
        this.store.setUsage(update);
        break;
      case "config_option_update":
        this.store.updateConfigOption(update);
        break;
      case "session_info_update":
        this.store.updateSessionInfo(update);
        break;
      case "available_commands_update":
        this.store.setAvailableCommands(update);
        break;
      // ... etc
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.store.showPermissionDialog(params, resolve);
    });
  }
}
```

**Key design**: `sessionUpdate` is called by the SDK during `connection.prompt()` execution. It runs concurrently with the prompt `await`. The UI must react to state changes in real-time — ink's `useState` + `useEffect` handles this via a shared store.

### Phase 3: State Management

#### `src/state/store.ts` — New file (M)
A simple observable store that Ink components subscribe to:

```typescript
export interface SessionState {
  messages: Message[];          // accumulated conversation
  activeToolCalls: Map<string, ToolCallState>;  // in-progress tools
  usage: { used: number; size: number } | null;
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  isStreaming: boolean;         // prompt() in-flight
  permissionDialog: PermissionState | null;
  pendingPrompt: Promise<PromptResponse> | null;
}
```

Use `useSyncExternalStore` (React 18) or a simple event emitter + `useState` for reactivity.

### Phase 4: Ink UI Components (MVP)

#### `src/ui/App.tsx` — New file (L)
Root component:
```
┌─────────────────────────────────────┐
│ Header: InvoxTUI v0.1 | connected  │
├─────────────────────────────────────┤
│                                     │
│  MessageList (scrollable)           │
│    - User messages                  │
│    - Agent text (markdown rendered) │
│    - Tool call cards (collapsed)    │
│    - Agent thoughts (dimmed)        │
│                                     │
├─────────────────────────────────────┤
│ StatusBar: model | usage | mode    │
├─────────────────────────────────────┤
│ Input: text input + Enter to send   │
│ Permission dialog (modal overlay)   │
└─────────────────────────────────────┘
```

#### `src/ui/MessageList.tsx` — New file (M)
- Renders the conversation history
- Scrolls to bottom on new content
- Groups consecutive `agent_message_chunk` into a single rendered block
- Markdown rendering via `marked` + `marked-terminal`

#### `src/ui/ToolCallCard.tsx` — New file (M)
- Shows tool name, kind icon, status spinner/check/cross
- Collapsed by default, expandable to show rawInput/content
- Status transitions: `in_progress` → `completed` / `failed`

#### `src/ui/InputBar.tsx` — New file (M)
- Text input using ink's `useInput` + `useStdin`
- Enter to submit, Shift+Enter for newline (if supported)
- Ctrl+C to cancel active prompt (sends `cancel()`)
- `/` prefix to trigger command palette from `availableCommands`

#### `src/ui/PermissionDialog.tsx` — New file (M)
- Modal overlay when `requestPermission` is called
- Shows tool name, rawInput preview
- Arrow keys to select option, Enter to confirm
- Default: "Allow" / "Deny"

#### `src/ui/StatusBar.tsx` — New file (S)
- Shows current model, agent, thinking level
- Token usage bar (used / size)
- Connection status indicator

#### `src/ui/ConfigSelector.tsx` — New file (M)
- Renders `configOptions` as selectable dropdowns
- Model selector, Agent/Thinking selectors
- Calls `connection.setSessionConfigOption()` on change

### Phase 5: Markdown Rendering

#### `src/ui/markdown.tsx` — New file (S)
- Configure `marked` with `marked-terminal` renderer
- Code block highlighting via `cli-highlight`
- Strip/sanitize terminal escape sequences from agent output
- Handle streaming: accumulate chunks, re-render full block on each chunk

### Phase 6: Enhanced Features

#### `src/acp/capabilities.ts` — New file (S)
- Advertise client capabilities in `initialize()`:
  - `fs.readTextFile: true` — implement via `node:fs` (read from TUI's cwd)
  - `fs.writeTextFile: true` — implement via `node:fs`
  - `terminal: true` — spawn child process, return terminal handle

#### `src/acp/fs-handler.ts` — New file (M)
- Implement `readTextFile` / `writeTextFile` on the Client
- Sandboxed to cwd + configurable allowlist
- Used by agent when it needs to read/write files via ACP (Invox uses its own tools, but other agents may use ACP FS)

#### `src/acp/terminal-handler.ts` — New file (L)
- Implement `createTerminal` / `terminalOutput` / `releaseTerminal`
- Spawn `child_process` for each terminal request
- Buffer output, stream to TUI terminal panel

### Phase 7: Polish

#### `src/ui/Theme.ts` — New file (S)
- Color palette, spacing, icons
- Configurable via env vars or `.invox-tui.json`

#### `src/ui/ScrollableBox.tsx` — New file (M)
- Custom scrollable container for message list
- Page Up/Down navigation
- Auto-scroll to bottom on new content, manual scroll pauses auto-scroll

#### `src/ui/Spinner.tsx` — New file (S)
- Animated spinner for in-progress tool calls
- Frame-based animation using ink's `useApp` + `setInterval`

---

## Project Structure

```
G:\OhMyProjs\InvoxTUI\
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.tsx                    # Entry point (arg parse, WS connect, render)
│   ├── acp/
│   │   ├── ws-stream.ts           # WebSocket → ACP Stream bridge
│   │   ├── connection.ts          # Connection lifecycle orchestrator
│   │   ├── tui-client.ts          # Client interface implementation
│   │   ├── capabilities.ts        # Client capability advertisement
│   │   ├── fs-handler.ts          # readTextFile / writeTextFile
│   │   └── terminal-handler.ts    # Terminal management
│   ├── state/
│   │   ├── store.ts               # Session state + observable pattern
│   │   └── types.ts               # State type definitions
│   └── ui/
│       ├── App.tsx                # Root component + layout
│       ├── MessageList.tsx         # Conversation display
│       ├── ToolCallCard.tsx        # Tool call visualization
│       ├── InputBar.tsx            # User input
│       ├── PermissionDialog.tsx    # Permission request modal
│       ├── StatusBar.tsx           # Bottom status display
│       ├── ConfigSelector.tsx      # Model/agent/thinking selectors
│       ├── markdown.tsx            # Markdown rendering utilities
│       ├── ScrollableBox.tsx       # Scrollable container
│       ├── Spinner.tsx             # Loading indicator
│       └── Theme.ts                # Colors and styling constants
└── .invox/
    └── plans/
        └── invox-tui.md           # This plan file
```

---

## Risks

1. **Ink stdin conflicts with WebSocket**: Ink captures stdin for UI input. When `requestPermission` fires during a `prompt()` call, the input focus must switch from the chat input to the permission dialog. Ink's focus model (only one component can capture input at a time) needs careful orchestration — use a global `mode` state (`"input"` | `"permission"` | `"config"`) to route input.

2. **Streaming re-render performance**: Agent sends dozens of `agent_message_chunk` notifications per second. Ink re-renders the full React tree on each state change. Mitigation: batch updates with `requestAnimationFrame` or debounce re-renders to ~30fps. Accumulate chunks in a buffer and flush on a timer.

3. **WebSocket connection lifecycle**: If the Invox server crashes or the WS drops, the TUI must detect this (via `ws.on("close")` / `connection.closed`) and show a reconnect prompt rather than hanging. The `ClientSideConnection.signal` AbortSignal fires on stream close — listen to it.

---

## Open Questions

1. **Multi-session support**: Should the TUI support multiple sessions simultaneously (tabbed UI), or is single-session sufficient for MVP? Recommendation: single session for MVP, multi-session in Phase 7+.

2. **History persistence**: Should the TUI save conversation history to disk (like Invox's `.invox/sessions/`) for session resume via `loadSession`? Recommendation: yes in Enhanced phase, using the same `PersistedSession` format.

3. **Agent message chunking strategy**: Should the TUI render markdown on every chunk (potentially expensive) or accumulate and re-render on idle (50ms debounce)? Recommendation: debounce with 50ms idle timeout.

4. **Theme customization**: Should the TUI support `.invox-tui.json` config file or just env vars? Recommendation: env vars for MVP, config file in Polish phase.

5. **Windows terminal compatibility**: Ink works on Windows Terminal but may have rendering issues in legacy `cmd.exe`. Should we detect and warn? Recommendation: detect terminal and warn if not Windows Terminal / ConEmu / VS Code terminal.

---

## Implementation Order

| # | Phase | Deliverable | Est. Size |
|---|-------|-------------|-----------|
| 1 | Phase 0 | Project scaffold, deps installed, `npm run dev` works | 1 day |
| 2 | Phase 1 | WS → Stream bridge, connection established, `initialize()` + `newSession()` succeed | 0.5 day |
| 3 | Phase 2 | `TuiClient` implements `sessionUpdate` + `requestPermission`, plain-text output to console | 1 day |
| 4 | Phase 3 | State store with observable pattern, Ink components subscribe | 0.5 day |
| 5 | Phase 4 | Full MVP TUI: message list, input bar, tool cards, permission dialog, status bar | 2 days |
| 6 | Phase 5 | Markdown rendering with syntax highlighting | 0.5 day |
| 7 | Phase 6 | FS + terminal capabilities, config selector, session resume | 1.5 days |
| 8 | Phase 7 | Scrollable box, spinner, theme, reconnect logic, history persistence | 1.5 days |

**Total estimate: ~8.5 days for a fully-featured TUI.**

MVP (Phases 0-4) is deliverable in ~5 days and provides: connect → create session → send prompt → see streaming output → handle permissions → cancel.
