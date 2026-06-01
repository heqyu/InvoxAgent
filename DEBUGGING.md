# Debugging invox

The challenge: invox runs as a child process spawned by Zed (or a WS client).
You don't launch it yourself, so you can't just hit F5. The fix is **launch
the agent with the Node inspector enabled, then attach a debugger over
TCP** (port 9229).

This works with any Node debugger that speaks the V8 Inspector Protocol:
**VS Code, Chrome DevTools, WebStorm, etc.** — Zed itself does NOT have a
Node debugger, so don't try "open invox in another Zed window."

---

## VS Code (recommended)

### One-time setup

The repo ships `.vscode/launch.json` with two profiles already wired up.

### 1. Tell Zed to launch invox with `--inspect`

In your Zed `settings.json` add a second agent entry alongside your normal
one:

```jsonc
{
  "agent_servers": {
    "invox": {
      "command": "node",
      "args": ["--import", "tsx", "G:/OhMyProjs/InvoxAgent/src/cli.ts"],
      "env": { "INVOX_BASE_URL": "...", "INVOX_API_KEY": "...", "INVOX_MODEL": "..." }
    },
    "invox-debug": {
      "command": "node",
      "args": [
        "--inspect=127.0.0.1:9229",
        "--import", "tsx",
        "G:/OhMyProjs/InvoxAgent/src/cli.ts"
      ],
      "env": {
        "INVOX_BASE_URL": "...",
        "INVOX_API_KEY": "...",
        "INVOX_MODEL": "...",
        "INVOX_LOG": "debug"
      }
    }
  }
}
```

Important: use `--inspect`, **not** `--inspect-brk`. The latter pauses the
process at startup waiting for a debugger — Zed will think invox crashed
and surface "Failed to Launch."

### 2. Open the project in VS Code

Open the **invox repo** in VS Code (the agent code, not the project Zed is
editing).

### 3. Set breakpoints

Click in the gutter on whatever line you want to pause at — `src/agent/agent.ts`,
`src/tools/router.ts`, etc. Source files are real `.ts`, no source maps
needed (tsx runs TypeScript directly).

### 4. In Zed, pick the `invox-debug` agent

Open the agent panel, switch to `invox-debug`. Send a prompt — Zed spawns
invox with the inspector listening.

### 5. In VS Code, F5 → "Attach to invox (Zed)"

The configured launch profile attaches to `127.0.0.1:9229`. The status bar
turns orange; breakpoints become solid red dots.

Send another prompt in Zed. Execution stops at your breakpoint.

### 6. After `npm run restart`

The launch profile has `"restart": true`, so VS Code automatically re-attaches
when Zed re-spawns invox. Just keep working.

---

## Chrome DevTools (no IDE)

If you don't have VS Code:

1. Configure Zed to launch with `--inspect=127.0.0.1:9229` (same as above).
2. Send a prompt in Zed so invox starts.
3. Open Chrome → `chrome://inspect`.
4. Under "Remote Target" you should see `node --import tsx ...`. Click
   "inspect."
5. A DevTools window opens. Sources tab → press Ctrl+P → type a filename
   to open it. Set breakpoints in the gutter.

This is fine for poking around but slower than VS Code for serious work.

---

## Standalone debugging (no Zed at all)

For unit-style debugging — running invox by itself with stdio piped to
the integrated terminal — use the `Run invox standalone` profile in
`.vscode/launch.json`. Defaults to `INVOX_MOCK=1` (echo provider) so you
can test changes without an LLM endpoint.

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| "Failed to Launch" right after switching to invox-debug | Used `--inspect-brk` | Switch to `--inspect` (no `-brk`). |
| Inspector port already in use | Another invox / node process is holding 9229 | `npm run restart` to kill it; or switch to a different port like `--inspect=127.0.0.1:9230` and update launch.json. |
| Breakpoints are hollow circles instead of solid red | Source paths don't match | Make sure VS Code has the **invox repo** open (not whatever project Zed is editing). |
| Step Into goes into Node internals | `skipFiles` not effective | Already configured in `.vscode/launch.json`; if you customize it, keep `<node_internals>/**` and `**/node_modules/**`. |
| After Zed re-spawns invox, debugger doesn't reattach | `"restart": false` | The shipped launch.json has `restart: true`; verify yours wasn't edited. |
