// Smoke test for the discovery module.
//
// Creates temp user/project directories with settings.json and plugins.json,
// then verifies discoverDirs() resolves all three tiers correctly.
//
// Usage: npx tsx examples/smoke-discovery.ts

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverDirs, clearDiscoveryCache } from "../src/discovery/index.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

async function main(): Promise<void> {
  console.log("[smoke-discovery] starting...\n");

  const tmpDir = join(tmpdir(), `invox-discovery-${Date.now()}`);

  // ── Setup ─────────────────────────────────────────────────────────

  // Project .claude/ with settings.json + plugins.json
  const projectClaude = join(tmpDir, ".claude");
  mkdirSync(projectClaude, { recursive: true });

  // project settings.json with hooks
  writeFileSync(
    join(projectClaude, "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "project-pre-tool" }],
          },
        ],
      },
      mcpServers: {
        projectServer: { command: "node", args: ["server.js"] },
      },
    }),
    "utf8",
  );

  // Plugin directory
  const pluginDir = join(tmpDir, "plugins", "my-plugin");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "plugin-stop-hook" }],
          },
        ],
      },
    }),
    "utf8",
  );

  // project plugins.json
  writeFileSync(
    join(projectClaude, "plugins.json"),
    JSON.stringify([{ path: pluginDir, enabled: true }]),
    "utf8",
  );

  try {
    clearDiscoveryCache();

    // ── 1. Basic resolution ─────────────────────────────────────────
    console.log("── 1. Basic resolution ────────────────────");
    const d = discoverDirs(tmpDir);
    ASSERT(d.userDir.includes(".claude"), "userDir ends with .claude");
    ASSERT(
      d.projectDir === projectClaude,
      `projectDir = ${d.projectDir}`,
    );

    // ── 2. Project settings loaded ─────────────────────────────────
    console.log("\n── 2. Project settings ───────────────────");
    ASSERT(d.projectSettings !== null, "projectSettings loaded");
    ASSERT(
      d.projectSettings!.hooks !== undefined,
      "projectSettings has hooks",
    );
    ASSERT(
      d.projectSettings!.hooks!.PreToolUse!.length === 1,
      "projectSettings has 1 PreToolUse group",
    );
    ASSERT(
      d.projectSettings!.mcpServers !== undefined,
      "projectSettings has mcpServers",
    );

    // ── 3. User settings ───────────────────────────────────────────
    console.log("\n── 3. User settings ──────────────────────");
    // user settings may or may not exist in the real environment
    // — we just verify it doesn't crash
    if (d.userSettings) {
      ASSERT(
        typeof d.userSettings === "object",
        "userSettings is an object (settings.json exists)",
      );
    } else {
      console.log("  ℹ user settings.json not found (OK — not required)");
    }

    // ── 4. Plugins resolved ─────────────────────────────────────────
    console.log("\n── 4. Plugins ────────────────────────────");
    ASSERT(d.plugins.length === 1, "1 plugin discovered");
    ASSERT(d.plugins[0]!.root === pluginDir, "plugin root correct");
    ASSERT(d.plugins[0]!.enabled === true, "plugin enabled");

    // ── 5. Cache ───────────────────────────────────────────────────
    console.log("\n── 5. Cache ──────────────────────────────");
    const d2 = discoverDirs(tmpDir);
    ASSERT(d2 === d, "discoverDirs returns cached result");
    clearDiscoveryCache(tmpDir);
    const d3 = discoverDirs(tmpDir);
    ASSERT(d3 !== d, "clearDiscoveryCache invalidates");

    // ── 6. No config dir ───────────────────────────────────────────
    console.log("\n── 6. No config dir ──────────────────────");
    const emptyDir = join(tmpdir(), `invox-discovery-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const empty = discoverDirs(emptyDir);
      ASSERT(
        empty.plugins.length === 0,
        "No plugins when no plugins.json",
      );
      ASSERT(
        empty.projectSettings === null,
        "No project settings when none exist",
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // ── 7. Disabled plugin ─────────────────────────────────────────
    console.log("\n── 7. Disabled plugin ────────────────────");
    const disabledDir = join(tmpdir(), `invox-discovery-disabled-${Date.now()}`);
    const disabledClaude = join(disabledDir, ".claude");
    mkdirSync(disabledClaude, { recursive: true });
    const disabledPluginDir = join(disabledDir, "plugins", "disabled");
    mkdirSync(join(disabledPluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(disabledPluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "disabled", version: "1.0.0" }),
    );
    writeFileSync(
      join(disabledClaude, "plugins.json"),
      JSON.stringify([{ path: disabledPluginDir, enabled: false }]),
    );
    try {
      clearDiscoveryCache(disabledDir);
      const disabled = discoverDirs(disabledDir);
      ASSERT(disabled.plugins.length === 1, "Disabled plugin still in list");
      ASSERT(
        disabled.plugins[0]!.enabled === false,
        "Disabled plugin marked enabled=false",
      );
    } finally {
      rmSync(disabledDir, { recursive: true, force: true });
    }
  } finally {
    clearDiscoveryCache();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-discovery] PASS");
}

main().catch((err) => {
  console.error("[smoke-discovery] FATAL:", err);
  process.exit(1);
});
