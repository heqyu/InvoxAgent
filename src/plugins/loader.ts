// Plugin loader — reads .claude/plugins.json, scans each plugin directory,
// and returns resolved skills ready to merge into the skill registry.
//
// Config locations (first found wins):
//   1. <cwd>/.claude/plugins.json   — project-level
//   2. ~/.claude/plugins.json       — user-level
//
// Plugin directory layout:
//   <path>/
//     .claude-plugin/plugin.json    — manifest (name, version, ...)
//     skills/<name>/SKILL.md        — skill definitions

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";
import type { PluginConfig, PluginManifest, PluginSkill } from "./types.js";

const PLUGINS_JSON = "plugins.json";
const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";
const SKILL_FILE = "SKILL.md";

// ── Public API ──────────────────────────────────────────────────────

const pluginSkillCache = new Map<string, Map<string, PluginSkill>>();

/**
 * Load all plugin-provided skills for the given cwd.
 *
 * Priority: project-level config overrides user-level on the same path.
 * Within a plugin, skills can be individually toggled.
 */
export function loadPluginSkills(cwd: string): Map<string, PluginSkill> {
  const cached = pluginSkillCache.get(cwd);
  if (cached) return cached;

  const skills = new Map<string, PluginSkill>();
  const configs = loadConfigs(cwd);

  for (const cfg of configs) {
    if (cfg.enabled === false) {
      log.info("plugins: plugin disabled", { path: cfg.path });
      continue;
    }
    loadPluginSkillsFromConfig(cfg, skills);
  }

  pluginSkillCache.set(cwd, skills);
  return skills;
}

export function clearPluginCache(cwd?: string): void {
  if (cwd) pluginSkillCache.delete(cwd);
  else pluginSkillCache.clear();
}

// ── Config loading ──────────────────────────────────────────────────

function loadConfigs(cwd: string): PluginConfig[] {
  // Project-level takes precedence; if it exists, user-level is skipped.
  const projectPath = join(cwd, ".claude", PLUGINS_JSON);
  if (existsSync(projectPath)) {
    return readConfig(projectPath, cwd) ?? [];
  }

  const userPath = join(homedir(), ".claude", PLUGINS_JSON);
  if (existsSync(userPath)) {
    return readConfig(userPath, homedir()) ?? [];
  }

  return [];
}

function readConfig(filePath: string, basePath: string): PluginConfig[] | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      log.warn("plugins: invalid config (not an array)", { filePath });
      return null;
    }

    // Normalize paths relative to the config file's parent dir.
    const configs: PluginConfig[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e["path"] !== "string" || !e["path"]) continue;

      const rawPath = e["path"] as string;
      const absPath = isAbsolute(rawPath)
        ? rawPath
        : resolve(basePath, rawPath);

      configs.push({
        path: absPath,
        enabled: e["enabled"] !== false,
        ...(e["skills"] && typeof e["skills"] === "object"
          ? { skills: e["skills"] as Record<string, boolean> }
          : {}),
      });
    }

    log.info("plugins: config loaded", {
      filePath,
      pluginCount: configs.length,
    });
    return configs;
  } catch (err) {
    log.warn("plugins: failed to read config", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Plugin scanning ─────────────────────────────────────────────────

function loadPluginSkillsFromConfig(
  cfg: PluginConfig,
  skills: Map<string, PluginSkill>,
): void {
  if (!isDir(cfg.path)) {
    log.warn("plugins: plugin path not found or not a directory", {
      path: cfg.path,
    });
    return;
  }

  const manifest = readManifest(cfg.path);
  const pluginName = manifest?.name ?? basename(cfg.path);

  const skillsDir = join(cfg.path, "skills");
  if (!isDir(skillsDir)) {
    log.info("plugins: no skills/ directory", {
      plugin: pluginName,
      path: cfg.path,
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
      if (cfg.skills) {
        const enabled = cfg.skills[id];
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
          pluginRoot: cfg.path,
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
    path: cfg.path,
    loaded,
    skipped,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function readManifest(pluginRoot: string): PluginManifest | null {
  const manifestPath = join(pluginRoot, MANIFEST_DIR, MANIFEST_FILE);
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      return parsed as PluginManifest;
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
