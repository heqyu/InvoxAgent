// Plugin 加载器 —— 在每个已解析的 plugin 目录下扫描 SKILL.md。
//
// plugin 列表来自 discovery（读 plugins.json），本文件只负责单个 plugin
// 内部的 skill 扫描。
//
// plugin 目录布局：
//   <root>/
//     .claude-plugin/plugin.json   — 清单（name / version / ...）
//     skills/<name>/SKILL.md       — skill 定义

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.js";
const log = createLogger("plugins");
import { discoverDirs } from "../discovery/index.js";
import type { PluginEntry } from "../discovery/types.js";

const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";
const SKILL_FILE = "SKILL.md";

/** 已解析的 plugin skill —— 可直接合并进 skill registry。 */
export interface PluginSkill {
  id: string;
  source: string;
  content: string;
  pluginName: string;
  pluginRoot: string;
}

const pluginSkillCache = new Map<string, Map<string, PluginSkill>>();

/**
 * 加载 cwd 对应的全部 plugin skills。
 * plugin 列表来自 discoverDirs()；单 plugin 内可通过 plugins.json 的 skills
 * 字段做按 skill 的精细开关。
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

// ── plugin 扫描 ─────────────────────────────────────────────────────

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

      // 单 skill 开关
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
        // SKILL.md 不存在或不可读 —— 静默跳过
      }
    }
  } catch {
    // skillsDir 读失败 —— 静默跳过
  }

  log.info("plugins: loaded", {
    plugin: pluginName,
    root: plugin.root,
    loaded,
    skipped,
  });
}

// ── helpers ─────────────────────────────────────────────────────────

function readManifest(pluginRoot: string): { name: string } | null {
  const manifestPath = join(pluginRoot, MANIFEST_DIR, MANIFEST_FILE);
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      return parsed as { name: string };
    }
  } catch {
    // 清单缺失或格式错误 —— 不致命
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
