// Smoke test for the plugin hook system (command-based).
//
// Creates a temp plugin with hook shell commands, loads via loadHooks(),
// and verifies hook loading, matcher filtering, and actual command execution.
//
// Usage: npx tsx examples/smoke-hooks.ts

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HookRegistry,
  loadHooks,
  clearHookCache,
} from "../src/plugins/hooks.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

// Use node -e for cross-platform JSON output.  Use single quotes inside
// the -e expression so the result is safe inside cmd.exe's /S /C wrapper.
function nodeJson(jsObj: string): string {
  return `node -e "process.stdout.write(JSON.stringify(${jsObj})+'\\n')"`;
}
function nodeBlock(msg: string): string {
  return `node -e "process.stderr.write('${msg}');process.exit(2)"`;
}

async function main(): Promise<void> {
  console.log("[smoke-hooks] starting...\n");

  const tmpDir = join(tmpdir(), `invox-hooks-${Date.now()}`);

  // Create a plugin with hooks
  const pluginDir = join(tmpDir, "plugins", "test-hooks");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });

  // Plugin manifest
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "test-hooks", version: "1.0.0" }, null, 2),
    "utf8",
  );

  // hooks.json with all 6 hook events + matchers
  // Commands use node -e with JS object literals (single quotes inside)
  // to avoid cmd.exe quoting issues on Windows.
  const hooksJson = {
    hooks: {
      SessionStart: [
        {
          description: "Echo session start",
          hooks: [{ type: "command", command: nodeJson("{continue:true}") }],
        },
      ],
      UserPromptSubmit: [
        {
          description: "Inject context on prompt",
          hooks: [
            {
              type: "command",
              command: nodeJson("{continue:true,systemMessage:'[hook: test]'}"),
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Write|Edit",
          description: "Pre-hook for write/edit tools",
          hooks: [{ type: "command", command: nodeJson("{continue:true}") }],
        },
        {
          matcher: "Bash",
          description: "Blocks Bash tool",
          hooks: [
            {
              type: "command",
              command: nodeBlock("dangerous command blocked"),
            },
          ],
        },
      ],
      PostToolUse: [
        {
          description: "Post-hook for all tools",
          hooks: [
            {
              type: "command",
              command: nodeJson("{continue:true,systemMessage:'[post: done]'}"),
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          description: "Post-failure hook",
          hooks: [
            {
              type: "command",
              command: nodeJson(
                "{continue:true,systemMessage:'[post: failed]'}",
              ),
            },
          ],
        },
      ],
      Stop: [
        {
          description: "Stop gate",
          hooks: [{ type: "command", command: nodeJson("{continue:true}") }],
        },
      ],
    },
  };

  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify(hooksJson, null, 2),
    "utf8",
  );

  // Write .claude/plugins.json
  mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".claude", "plugins.json"),
    JSON.stringify([{ path: pluginDir, enabled: true }], null, 2),
    "utf8",
  );

  try {
    clearHookCache();
    const registry = loadHooks(tmpDir);

    // 1. Hook loading from hooks.json
    console.log("── 1. Hook loading from hooks.json ────────");
    ASSERT(
      registry.sessionStart.length === 1,
      "SessionStart: 1 hook group loaded",
    );
    ASSERT(
      registry.userPromptSubmit.length === 1,
      "UserPromptSubmit: 1 hook group",
    );
    ASSERT(registry.preToolUse.length === 2, "PreToolUse: 2 hook groups");
    ASSERT(registry.postToolUse.length === 1, "PostToolUse: 1 hook group");
    ASSERT(
      registry.postToolUseFailure.length === 1,
      "PostToolUseFailure: 1 hook group",
    );
    ASSERT(registry.stop.length === 1, "Stop: 1 hook group");

    // 2. Hook group structure
    console.log("\n── 2. Hook group structure ────────────────");
    const sessionGroup = registry.sessionStart[0]!;
    ASSERT(sessionGroup.hooks.length === 1, "SessionStart: 1 command");
    ASSERT(
      sessionGroup.hooks[0]!.type === "command",
      "Command type is 'command'",
    );
    ASSERT(
      sessionGroup.pluginName === "test-hooks",
      "Plugin name = 'test-hooks'",
    );

    const preWrite = registry.preToolUse[0]!;
    ASSERT(
      preWrite.matcher === "Write|Edit",
      "PreToolUse has matcher 'Write|Edit'",
    );
    ASSERT(
      preWrite.description === "Pre-hook for write/edit tools",
      "PreToolUse has description",
    );

    const preBash = registry.preToolUse[1]!;
    ASSERT(preBash.matcher === "Bash", "PreToolUse has Bash blocker matcher");

    // 3. Cache
    console.log("\n── 3. Hook cache ────────────────────────");
    const cached = loadHooks(tmpDir);
    ASSERT(cached === registry, "loadHooks returns cached registry");
    clearHookCache(tmpDir);
    const fresh = loadHooks(tmpDir);
    ASSERT(fresh !== registry, "clearHookCache invalidates cache");
    ASSERT(fresh.sessionStart.length === 1, "Fresh load after clear works");

    // 4. No plugins config
    console.log("\n── 4. No plugins config ──────────────────");
    const noPluginsDir = join(tmpdir(), `invox-noplugins-${Date.now()}`);
    mkdirSync(join(noPluginsDir, ".claude"), { recursive: true });
    writeFileSync(join(noPluginsDir, ".claude", "plugins.json"), "[]", "utf8");
    const noHooks = loadHooks(noPluginsDir);
    ASSERT(noHooks.sessionStart.length === 0, "No hooks when no plugins");
    rmSync(noPluginsDir, { recursive: true, force: true });

    // 5. Disabled plugin
    console.log("\n── 5. Disabled plugin ────────────────────");
    const disabledDir = join(tmpdir(), `invox-disabled-${Date.now()}`);
    const disabledPlugin = join(disabledDir, "plugins", "disabled-hook");
    mkdirSync(join(disabledPlugin, ".claude-plugin"), { recursive: true });
    mkdirSync(join(disabledPlugin, "hooks"), { recursive: true });
    writeFileSync(
      join(disabledPlugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "disabled-hook", version: "1.0.0" }),
    );
    writeFileSync(
      join(disabledPlugin, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo ok" }] }],
        },
      }),
    );
    mkdirSync(join(disabledDir, ".claude"), { recursive: true });
    writeFileSync(
      join(disabledDir, ".claude", "plugins.json"),
      JSON.stringify([{ path: disabledPlugin, enabled: false }]),
    );
    clearHookCache(disabledDir);
    const disabledHooks = loadHooks(disabledDir);
    ASSERT(
      disabledHooks.sessionStart.length === 0,
      "Disabled plugin hooks not loaded",
    );
    rmSync(disabledDir, { recursive: true, force: true });

    // 6. Multiple plugins
    console.log("\n── 6. Multiple plugin hooks ──────────────");
    const multiDir = join(tmpdir(), `invox-multi-${Date.now()}`);
    for (const name of ["plugin-one", "plugin-two"]) {
      const pDir = join(multiDir, "plugins", name);
      mkdirSync(join(pDir, ".claude-plugin"), { recursive: true });
      mkdirSync(join(pDir, "hooks"), { recursive: true });
      writeFileSync(
        join(pDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
      writeFileSync(
        join(pDir, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo ok" }] },
            ],
          },
        }),
      );
    }
    mkdirSync(join(multiDir, ".claude"), { recursive: true });
    writeFileSync(
      join(multiDir, ".claude", "plugins.json"),
      JSON.stringify([
        { path: join(multiDir, "plugins", "plugin-one"), enabled: true },
        { path: join(multiDir, "plugins", "plugin-two"), enabled: true },
      ]),
    );
    clearHookCache(multiDir);
    const multiHooks = loadHooks(multiDir);
    ASSERT(multiHooks.sessionStart.length === 2, "Two plugins = 2 groups");
    rmSync(multiDir, { recursive: true, force: true });

    // 7. Command execution via hook runners
    console.log("\n── 7. Command execution ──────────────────");
    const {
      runUserPromptSubmit,
      runPreToolUse,
      runPostToolUse,
      runPostToolUseFailure,
    } = await import("../src/plugins/hooks.js");

    // UserPromptSubmit: node -e outputs JSON
    const submit = await runUserPromptSubmit(registry, {
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(submit.continue, "UserPromptSubmit: continue=true");
    ASSERT(
      submit.systemMessage?.includes("[hook: test]"),
      "UserPromptSubmit: systemMessage = [hook: test]",
    );

    // PostToolUse: node -e outputs JSON with systemMessage
    const post = await runPostToolUse(registry, {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
      tool_response: "content",
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(
      post.systemMessage?.includes("[post: done]"),
      "PostToolUse: systemMessage = [post: done]",
    );

    // PostToolUseFailure: node -e outputs JSON
    const postFail = await runPostToolUseFailure(registry, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
      tool_input: { file_path: "/bad.txt" },
      tool_response: "error",
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(
      postFail.systemMessage?.includes("[post: failed]"),
      "PostToolUseFailure: systemMessage = [post: failed]",
    );

    // PreToolUse: Bash is blocked (exit code 2)
    const preBlocked = await runPreToolUse(registry, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(!preBlocked.allow, "PreToolUse: Bash blocked (exit 2 protocol)");
    ASSERT(
      preBlocked.reason?.includes("blocked") ||
        preBlocked.reason?.includes("dangerous"),
      "PreToolUse: block includes reason",
    );

    // PreToolUse: Read is NOT matched by "Write|Edit" or "Bash" matchers
    const preRead = await runPreToolUse(registry, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(preRead.allow, "PreToolUse: Read allowed (no matcher match)");

    // PreToolUse: Write IS matched by "Write|Edit" matcher
    const preWriteExec = await runPreToolUse(registry, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/test.txt" },
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(
      preWriteExec.allow,
      "PreToolUse: Write allowed (matched, not blocked)",
    );

    // 8. Empty registry
    console.log("\n── 8. Empty registry ─────────────────────");
    const empty = new HookRegistry();
    const emptySubmit = await runUserPromptSubmit(empty, {
      hook_event_name: "UserPromptSubmit",
      prompt: "test",
      session_id: "sess-1",
      cwd: tmpDir,
    });
    ASSERT(emptySubmit.continue, "Empty registry: continue=true");
    ASSERT(!emptySubmit.systemMessage, "Empty registry: no systemMessage");
  } finally {
    clearHookCache();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-hooks] PASS");
}

main().catch((err) => {
  console.error("[smoke-hooks] FATAL:", err);
  process.exit(1);
});
