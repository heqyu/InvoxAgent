// Plugin loader — scans plugin directories for skills (SKILL.md files).
//
// Plugin list comes from the discovery module (which reads plugins.json
// from user or project level). This file only handles the skill-specific
// scanning within each resolved plugin directory.
//
// Plugin directory layout:
//   <path>/
//     .claude-plugin/plugin.json    — manifest (name, version, ...)
//     skills/<name>/SKILL.md        — skill definitions

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { discoverDirs } from "../discovery/index.js";
import type { PluginEntry } from "../discovery/types.js";

const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";
const SKILL_FILE = "SKILL.md";

// ── Plugin skill type ───────────────────────────────────────────────

/**
 * A resolved skill loaded from a plugin — ready to merge into the
 * skill registry.
 */
export interface PluginSkill {
  id: string;
  source: string;
  content: string;
  pluginName: string;
  pluginRoot: string;
}

// ── Public API ──────────────────────────────────────────────────────

const pluginSkillCache = new Map<string, Map<string, PluginSkill>>();

/**
 * Load all plugin-provided skills for the given cwd.
 *
 * Plugin list comes from discoverDirs() (reads plugins.json).
 * Within a plugin, skills can be individually toggled via the
 * skills field in plugins.json.
 */
export function loadPluginSkills(cwd: string): Map<string, PluginSkill> {
  const cached = pluginSkillCache.get(cwd);
  if (cached) return cached;

  const skills = new Map<string, PluginSkill>();
  const discovery = discoverDirs(cwd);

  for (const plugin of discovery.plugins) {
    if (!plugin.enabled) {
      log.info("plugins: plugin disabled", { root: plugin.root });
      continue;
    }
    loadPluginSkillsFromEntry(plugin, skills);
  }

  pluginSkillCache.set(cwd, skills);
  return skills;
}

export function clearPluginCache(cwd?: string): void {
  if (cwd) pluginSkillCache.delete(cwd);
  else pluginSkillCache.clear();
}

// ── Plugin scanning ─────────────────────────────────────────────────

function loadPluginSkillsFromEntry(
  plugin: PluginEntry,
  skills: Map<string, PluginSkill>,
): void {
  if (!isDir(plugin.root)) {
    log.warn("plugins: plugin root not found or not a directory", {
      root: plugin.root,
    });
    return;
  }

  const manifest = readManifest(plugin.root);
  const pluginName = manifest?.name ?? basename(plugin.root);

  const skillsDir = join(plugin.root, "skills");
  if (!isDir(skillsDir)) {
    log.info("plugins: no skills/ directory", {
      plugin: pluginName,
      root: plugin.root,
    });
    return;
  }

  let loaded = 0;
  let skipped = 0;

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!id) continue;

      // Check per-skill toggle
      if (plugin.skills) {
        const enabled = plugin.skills[id];
        if (enabled === false) {
          skipped++;
          continue;
        }
      }

      const skillFile = join(skillsDir, id, SKILL_FILE);
      try {
        const content = readFileSync(skillFile, "utf8");
        if (!content.trim()) continue;
        skills.set(id, {
          id,
          source: skillFile,
          content,
          pluginName,
          pluginRoot: plugin.root,
        });
        loaded++;
      } catch {
        // SKILL.md missing or unreadable — skip silently
      }
    }
  } catch {
    // skillsDir read failed — skip silently
  }

  log.info("plugins: loaded", {
    plugin: pluginName,
    root: plugin.root,
    loaded,
    skipped,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function readManifest(pluginRoot: string): { name: string } | null {
  const manifestPath = join(pluginRoot, MANIFEST_DIR, MANIFEST_FILE);
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      return parsed as { name: string };
    }
  } catch {
    // Manifest missing or malformed — not fatal
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function basename(p: string): string {
  const sep = p.includes("/") ? "/" : "\\";
  const parts = p.replace(/[\\/]+$/, "").split(sep);
  return parts[parts.length - 1] ?? p;
}
