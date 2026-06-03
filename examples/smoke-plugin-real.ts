// Load real plugins from ECOMarket via .claude/plugins.json format.
//
// Usage: npx tsx examples/smoke-plugin-real.ts [ECOMarket-root]
// Writes a temp config, loads skills, then cleans up.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginSkills, clearPluginCache } from "../src/plugins/loader.js";

async function main() {
  const ecomarket = process.argv[2];
  if (!ecomarket) {
    console.error(
      "Usage: npx tsx examples/smoke-plugin-real.ts <ECOMarket-root>",
    );
    process.exit(1);
  }

  // Use a temp cwd so we don't clobber the project's config
  const cwd = join(tmpdir(), `invox-real-test-${Date.now()}`);
  mkdirSync(join(cwd, ".claude"), { recursive: true });

  // Write a .claude/plugins.json that references ECOMarket plugins
  const pluginsJson = join(cwd, ".claude", "plugins.json");
  const config = [
    { path: join(ecomarket, "plugins", "ai-coding"), enabled: true },
    {
      path: join(ecomarket, "plugins", "misc-skills"),
      enabled: true,
      skills: { "self-constrained-build": false },
    },
    { path: join(ecomarket, "plugins", "project-skills"), enabled: true },
    { path: join(ecomarket, "plugins", "tencent-skills"), enabled: false },
    { path: join(ecomarket, "plugins", "weekly-summary"), enabled: true },
  ];

  writeFileSync(pluginsJson, JSON.stringify(config, null, 2), "utf8");

  console.log(`\n═══ Plugin Loading Report (v2) ═══`);
  console.log(`Config: ${pluginsJson}`);
  console.log(`CWD: ${cwd}\n`);

  clearPluginCache();
  const skills = loadPluginSkills(cwd);

  console.log(`\n── Summary ──────────────────────────`);
  console.log(`Total plugin skills loaded: ${skills.size}`);

  if (skills.size > 0) {
    const byPlugin = new Map<string, { name: string; source: string }[]>();
    for (const [id, s] of skills) {
      const list = byPlugin.get(s.pluginName) ?? [];
      list.push({ name: id, source: s.source });
      byPlugin.set(s.pluginName, list);
    }
    for (const [plugin, ps] of byPlugin) {
      console.log(`\n┌─ Plugin: ${plugin}`);
      console.log(`│  Skills (${ps.length}):`);
      for (const s of ps.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`│    • ${s.name}`);
        console.log(`│      └─ ${s.source}`);
      }
      console.log(`└──────────────────────────`);
    }
  }

  // Clean up temp dir
  clearPluginCache();
  rmSync(cwd, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
