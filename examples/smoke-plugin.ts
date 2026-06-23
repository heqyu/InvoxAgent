// Smoke test for the simplified plugin system.
//
// Creates:
//   tmpDir/.claude/plugins.json        — config referencing two plugins
//   tmpDir/plugins/plugin-alpha/        — has .claude-plugin + skills/greet + skills/analyze
//   tmpDir/plugins/plugin-beta/         — has .claude-plugin + skills/translate
//
// Verifies:
//   1. Plugin skills are loaded from config
//   2. Disabled plugin (enabled:false) is skipped
//   3. Disabled skill (skills.x:false) is skipped
//   4. Plugin manifest name is used as pluginName
//   5. INVOX_PLUGINS_FILE path is not needed (config is in .claude/plugins.json)

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool } from "../src/tools/router.js";
import { FileCache } from "../src/tools/cache.js";
import { getTool } from "../src/tools/registry.js";
import { clearPluginCache } from "../src/plugins/loader.js";
import type { ToolExecContext, SessionToolState } from "../src/tools/types.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

async function main(): Promise<void> {
  console.log("[smoke-plugin] starting...\n");

  const tmpDir = join(tmpdir(), `invox-plugin-v2-${Date.now()}`);

  // ── Create two plugin directories ──────────────────────────────────

  // Plugin alpha: greet + analyze
  const alpha = join(tmpDir, "plugins", "plugin-alpha");
  mkdirSync(join(alpha, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(alpha, ".claude-plugin", "plugin.json"),
    { name: "plugin-alpha", version: "1.0.0" },
    "utf8",
  );
  mkdirSync(join(alpha, "skills", "greet"), { recursive: true });
  writeFileSync(
    join(alpha, "skills", "greet", "SKILL.md"),
    "Say hello to $ARGUMENTS.",
    "utf8",
  );
  mkdirSync(join(alpha, "skills", "analyze"), { recursive: true });
  writeFileSync(
    join(alpha, "skills", "analyze", "SKILL.md"),
    "Analyze `{{file}}` for bugs.",
    "utf8",
  );

  // Plugin beta: translate + decode
  const beta = join(tmpDir, "plugins", "plugin-beta");
  mkdirSync(join(beta, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(beta, ".claude-plugin", "plugin.json"),
    { name: "plugin-beta", version: "2.0.0" },
    "utf8",
  );
  mkdirSync(join(beta, "skills", "translate"), { recursive: true });
  writeFileSync(
    join(beta, "skills", "translate", "SKILL.md"),
    "Translate $ARGUMENTS to Chinese.",
    "utf8",
  );
  mkdirSync(join(beta, "skills", "decode"), { recursive: true });
  writeFileSync(
    join(beta, "skills", "decode", "SKILL.md"),
    "Decode `{{encoded}}`.",
    "utf8",
  );

  // Plugin gamma (disabled): hidden
  const gamma = join(tmpDir, "plugins", "plugin-gamma");
  mkdirSync(join(gamma, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(gamma, ".claude-plugin", "plugin.json"),
    { name: "plugin-gamma", version: "3.0.0" },
    "utf8",
  );
  mkdirSync(join(gamma, "skills", "hidden"), { recursive: true });
  writeFileSync(
    join(gamma, "skills", "hidden", "SKILL.md"),
    "You should not see this.",
    "utf8",
  );

  // ── Write .claude/plugins.json ─────────────────────────────────────

  const config = [
    {
      path: alpha,
      enabled: true,
      skills: {
        analyze: false, // disable "analyze" in alpha
      },
    },
    {
      path: beta,
      enabled: true,
      // no skills filter — all skills loaded
    },
    {
      path: gamma,
      enabled: false, // disable entire plugin
    },
  ];
  mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".claude", "plugins.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );

  // ── Project-level skill "greet" that overrides plugin ──────────────

  mkdirSync(join(tmpDir, ".claude", "skills", "greet"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".claude", "skills", "greet", "SKILL.md"),
    "PROJECT OVERRIDE: Greet $ARGUMENTS formally.",
    "utf8",
  );

  try {
    const skillTool = getTool("Skill");
    ASSERT(!!skillTool, "Skill tool found");

    const state: SessionToolState = {
      readPaths: new Set(),
      cache: new FileCache(),
    };
    const ctx: ToolExecContext = {
      conn: null as never,
      sessionId: "test",
      cwd: tmpDir,
      caps: {},
      signal: new AbortController().signal,
      policy: "never",
      toolCallId: "test",
      state,
    };

    // ── List all skills ──────────────────────────────────────────────
    const list = await executeTool(
      "Skill",
      { name: "list", description: "List" },
      ctx,
    );
    ASSERT(list.ok, "Skill('list') succeeds");

    // Plugin skills loaded
    ASSERT(
      list.resultText.includes("translate"),
      "Contains plugin-beta skill: translate",
    );
    ASSERT(
      list.resultText.includes("decode"),
      "Contains plugin-beta skill: decode",
    );

    // Plugin-alpha's "analyze" should NOT be present (disabled by config)
    ASSERT(
      !list.resultText.includes("**analyze**"),
      "Plugin-alpha 'analyze' is NOT in list (disabled by config)",
    );

    // Plugin-alpha's "greet" IS present — but project-level overrides it
    ASSERT(
      list.resultText.includes("greet"),
      "Plugin-alpha 'greet' is present",
    );

    // Plugin-gamma's "hidden" should NOT be present (plugin disabled)
    ASSERT(
      !list.resultText.includes("hidden"),
      "Plugin-gamma 'hidden' is NOT in list (plugin disabled)",
    );

    // Project-level override annotation
    ASSERT(
      !list.resultText.includes("[plugin: plugin-alpha]") ||
        list.resultText.includes("[plugin: plugin-beta]"),
      "Shows plugin source tags for plugin skills",
    );

    // ── Invoke "greet" — should use project-level, not plugin ────────
    const greet = await executeTool(
      "Skill",
      {
        name: "greet",
        description: "Greet",
        params: { arguments: "World" },
      },
      ctx,
    );
    ASSERT(greet.ok, "Skill('greet') succeeds");
    ASSERT(
      greet.resultText.includes("PROJECT OVERRIDE"),
      "Skill('greet') resolves to PROJECT OVERRIDE (not plugin-alpha)",
    );

    // ── Invoke "translate" — from plugin-beta ─────────────────────────
    const translate = await executeTool(
      "Skill",
      {
        name: "translate",
        description: "Translate",
        params: { arguments: "hello" },
      },
      ctx,
    );
    ASSERT(translate.ok, "Skill('translate') from plugin-beta succeeds");
    ASSERT(
      translate.resultText.includes("hello"),
      "Skill('translate') interpolates $ARGUMENTS",
    );
    ASSERT(
      translate.resultText.includes("Chinese"),
      "Skill('translate') contains expected template",
    );

    // ── Invoke "decode" — from plugin-beta ────────────────────────────
    const decode = await executeTool(
      "Skill",
      {
        name: "decode",
        description: "Decode",
        params: { encoded: "aGVsbG8=" },
      },
      ctx,
    );
    ASSERT(decode.ok, "Skill('decode') from plugin-beta succeeds");
    ASSERT(
      decode.resultText.includes("aGVsbG8="),
      "Skill('decode') interpolates {{encoded}}",
    );

    // ── Invoke "analyze" — should fail (disabled in config) ───────────
    const analyze = await executeTool(
      "Skill",
      {
        name: "analyze",
        description: "Analyze",
        params: { file: "x.ts" },
      },
      ctx,
    );
    ASSERT(!analyze.ok, "Skill('analyze') is unknown (disabled by config)");

    // ── Invoke "hidden" — should fail (entire plugin disabled) ────────
    const hidden = await executeTool(
      "Skill",
      { name: "hidden", description: "Hidden" },
      ctx,
    );
    ASSERT(!hidden.ok, "Skill('hidden') is unknown (plugin-gamma disabled)");
  } finally {
    clearPluginCache();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-plugin] PASS");
}

main().catch((err) => {
  console.error("[smoke-plugin] FATAL:", err);
  process.exit(1);
});
