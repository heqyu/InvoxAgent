// Protocol alignment test for the hook system.
//
// Verifies invox's hook behavior matches the Claude Code hooks spec:
// https://code.claude.com/docs/en/hooks
//
// Key protocol rules tested:
//   1. Exit code 2: ignores stdout, stderr is the block reason
//   2. Exit code 0 + decision:"block": blocks with reason from JSON
//   3. Exit code 0 + decision:"allow": allows
//   4. Exit code 0 + no output: allows (no decision = no opinion)
//   5. Block breaks the hook loop (first block wins)
//   6. Stop hook: decision:"block" + reason prevents agent from stopping
//   7. PostToolUse: exit code 2 shows stderr as context
//   8. suppressOutput behavior
//
// Usage: npx tsx examples/smoke-hooks-protocol.ts

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HookRegistry,
  loadHooks,
  clearHookCache,
  runPreToolUse,
  runPostToolUse,
  runStop,
  runUserPromptSubmit,
} from "../src/plugins/hooks.js";
import { clearDiscoveryCache } from "../src/discovery/index.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

// Helper: build a hook registry from a hooks.json object
function makeRegistry(
  hooksJson: Record<string, unknown>,
  tmpDir: string,
): HookRegistry {
  const pluginDir = join(tmpDir, "plugins", `test-${Date.now()}`);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "protocol-test", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: hooksJson }),
    "utf8",
  );

  const projectClaude = join(tmpDir, ".claude");
  mkdirSync(projectClaude, { recursive: true });
  writeFileSync(
    join(projectClaude, "plugins.json"),
    JSON.stringify([{ path: pluginDir, enabled: true }]),
    "utf8",
  );

  clearHookCache(tmpDir);
  clearDiscoveryCache(tmpDir);
  return loadHooks(tmpDir);
}

// node -e helpers (cross-platform safe)
function nodeJson(jsObj: string): string {
  return `node -e "process.stdout.write(JSON.stringify(${jsObj})+'\\n')"`;
}
function nodeExit2(stderrMsg: string): string {
  return `node -e "process.stderr.write('${stderrMsg}');process.exit(2)"`;
}
function nodeJsonAndExit2(
  jsonObj: string,
  stderrMsg: string,
  dir: string,
): string {
  // Writes JSON to stdout AND exits with code 2 — per spec, stdout should be ignored.
  // Write a temp script to avoid all shell quoting issues.
  const scriptPath = join(dir, `hook-exit2-${Date.now()}.mjs`);
  writeFileSync(
    scriptPath,
    `process.stdout.write(${JSON.stringify(jsonObj)} + "\\n");\nprocess.stderr.write(${JSON.stringify(stderrMsg)});\nprocess.exit(2);\n`,
    "utf8",
  );
  return `node "${scriptPath}"`;
}

const BASE_CTX = {
  session_id: "test-session",
  cwd: "/tmp/test",
  model: "test-model",
  client: "test-client",
  version: "0.0.0",
};

async function main(): Promise<void> {
  console.log("[smoke-hooks-protocol] starting...\n");

  const tmpDir = join(tmpdir(), `invox-protocol-${Date.now()}`);

  // Isolate from real HOME
  const fakeHome = join(tmpDir, "fake-home");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".claude", "settings.json"), "{}", "utf8");
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  try {
    mkdirSync(tmpDir, { recursive: true });

    // ── 1. Exit code 2 ignores stdout, uses stderr ─────────────────
    console.log("── 1. Exit code 2 protocol ───────────────");

    // Test 1a: exit 2 with stderr → blocks with stderr as reason
    const r1 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: nodeExit2("dangerous command") },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre1 = await runPreToolUse(r1, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    ASSERT(!pre1.allow, "1a: exit 2 blocks tool");
    ASSERT(
      pre1.reason?.includes("dangerous command"),
      "1a: reason from stderr matches",
    );

    // Test 1b: exit 2 with stdout JSON AND stderr → stdout IGNORED
    const r1b = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJsonAndExit2(
                  '{"continue":true,"systemMessage":"should be ignored"}',
                  "stderr is king",
                  tmpDir,
                ),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre1b = await runPreToolUse(r1b, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Bash",
      tool_input: { command: "test" },
    });
    ASSERT(!pre1b.allow, "1b: exit 2 blocks even with stdout JSON");
    ASSERT(
      (pre1b.reason ?? "").includes("stderr is king") ||
        (pre1b.systemMessage ?? "").includes("stderr is king"),
      "1b: stderr used, stdout ignored",
    );
    ASSERT(
      !(pre1b.reason ?? "").includes("should be ignored") &&
        !(pre1b.systemMessage ?? "").includes("should be ignored"),
      "1b: stdout JSON NOT in reason",
    );

    // ── 2. Exit code 0 + decision:"block" ─────────────────────────
    console.log("\n── 2. decision:'block' (exit 0) ──────────");
    const r2 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson(
                  "{decision:'block',reason:'policy violation'}",
                ),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre2 = await runPreToolUse(r2, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Write",
      tool_input: { file_path: "/etc/passwd" },
    });
    ASSERT(!pre2.allow, "2: decision:block blocks tool");
    ASSERT(
      pre2.reason?.includes("policy violation"),
      "2: reason from JSON matches",
    );

    // ── 3. Exit code 0 + decision:"allow" ─────────────────────────
    console.log("\n── 3. decision:'allow' (exit 0) ──────────");
    const r3 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{decision:'allow'}"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre3 = await runPreToolUse(r3, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
    });
    ASSERT(pre3.allow, "3: decision:allow allows tool");

    // ── 4. Exit 0 + no stdout → allows (no opinion) ───────────────
    console.log("\n── 4. No output = no opinion ─────────────");
    const r4 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: 'node -e ""' }],
          },
        ],
      },
      tmpDir,
    );
    const pre4 = await runPreToolUse(r4, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
    });
    ASSERT(pre4.allow, "4: no output = allow (no decision)");

    // ── 5. Block breaks the loop (first block wins) ────────────────
    console.log("\n── 5. Block breaks loop ──────────────────");
    const secondHookRan = join(tmpDir, "second-ran.flag");
    try {
      rmSync(secondHookRan);
    } catch {}
    const r5 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              // First hook: blocks
              {
                type: "command",
                command: nodeJson(
                  "{decision:'block',reason:'blocked by first'}",
                ),
              },
              // Second hook: should NOT run (loop should break)
              {
                type: "command",
                command:
                  "node -e \"require('fs').writeFileSync('" +
                  secondHookRan.replace(/\\/g, "/") +
                  "', 'ran')\"",
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre5 = await runPreToolUse(r5, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Bash",
      tool_input: { command: "test" },
    });
    ASSERT(!pre5.allow, "5: tool blocked");
    ASSERT(
      pre5.reason?.includes("blocked by first"),
      "5: reason from first hook",
    );
    // Second hook should not have run
    const { existsSync } = await import("node:fs");
    ASSERT(
      !existsSync(secondHookRan),
      "5: second hook did NOT run (loop broke)",
    );

    // ── 6. Stop hook: decision:"block" + reason ────────────────────
    console.log("\n── 6. Stop hook block ────────────────────");
    const r6 = makeRegistry(
      {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson(
                  "{decision:'block',reason:'Run tests before stopping'}",
                ),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const stop6 = await runStop(r6, {
      hook_event_name: "Stop",
      ...BASE_CTX,
      stop_hook_active: false,
    });
    ASSERT(!stop6.continue, "6: Stop hook blocks (continue=false)");
    ASSERT(
      stop6.systemMessage?.includes("Run tests before stopping"),
      "6: reason propagated as systemMessage",
    );

    // ── 7. Stop hook exit code 2 also blocks ───────────────────────
    console.log("\n── 7. Stop hook exit 2 ───────────────────");
    const r7 = makeRegistry(
      {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: nodeExit2("must complete task first"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const stop7 = await runStop(r7, {
      hook_event_name: "Stop",
      ...BASE_CTX,
      stop_hook_active: false,
    });
    ASSERT(!stop7.continue, "7: Stop exit 2 blocks");
    ASSERT(
      stop7.systemMessage?.includes("must complete task first"),
      "7: stderr as systemMessage",
    );

    // ── 8. PostToolUse: exit 2 shows stderr as context ─────────────
    console.log("\n── 8. PostToolUse exit 2 ─────────────────");
    const r8 = makeRegistry(
      {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeExit2("lint errors found"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const post8 = await runPostToolUse(r8, {
      hook_event_name: "PostToolUse",
      ...BASE_CTX,
      tool_name: "Write",
      tool_input: { file_path: "/test.ts" },
      tool_response: "ok",
    });
    // PostToolUse exit 2: tool already ran, so we show stderr as context.
    // The hook runner returns the block result, but agent.ts handles it
    // by injecting as context (not blocking).
    ASSERT(
      post8.systemMessage?.includes("lint errors found"),
      "8: PostToolUse exit 2 stderr as systemMessage",
    );

    // ── 9. UserPromptSubmit: exit 2 blocks prompt ──────────────────
    console.log("\n── 9. UserPromptSubmit exit 2 ────────────");
    const r9 = makeRegistry(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: nodeExit2("prompt rejected by policy"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const submit9 = await runUserPromptSubmit(r9, {
      hook_event_name: "UserPromptSubmit",
      ...BASE_CTX,
      prompt: "do something bad",
    });
    ASSERT(!submit9.continue, "9: UserPromptSubmit exit 2 blocks");
    ASSERT(
      submit9.systemMessage?.includes("prompt rejected by policy"),
      "9: stderr as systemMessage",
    );

    // ── 10. UserPromptSubmit: decision:block ───────────────────────
    console.log("\n── 10. UserPromptSubmit decision:block ───");
    const r10 = makeRegistry(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{decision:'block',reason:'not allowed'}"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const submit10 = await runUserPromptSubmit(r10, {
      hook_event_name: "UserPromptSubmit",
      ...BASE_CTX,
      prompt: "hack the system",
    });
    ASSERT(!submit10.continue, "10: decision:block blocks prompt");
    ASSERT(
      submit10.systemMessage?.includes("not allowed"),
      "10: reason as systemMessage",
    );

    // ── 11. continue:false universal field ─────────────────────────
    console.log("\n── 11. continue:false ────────────────────");
    const r11 = makeRegistry(
      {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{continue:false,systemMessage:'halt all'}"),
              },
            ],
          },
        ],
      },
      tmpDir,
    );
    const pre11 = await runPreToolUse(r11, {
      hook_event_name: "PreToolUse",
      ...BASE_CTX,
      tool_name: "Bash",
      tool_input: { command: "test" },
    });
    ASSERT(!pre11.allow, "11: continue:false blocks");
  } finally {
    clearHookCache();
    clearDiscoveryCache();
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined)
      process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-hooks-protocol] PASS");
}

main().catch((err) => {
  console.error("[smoke-hooks-protocol] FATAL:", err);
  process.exit(1);
});
