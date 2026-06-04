// Discovery 模块 —— 三级配置目录的统一解析入口。
//
// 来源（低 → 高优先级）：
//   1. User    : ~/.claude/                  (settings.json, plugins.json)
//   2. Project : <cwd>/.claude/              (settings.json, plugins.json)
//   3. Plugins : plugins.json 列出的目录     (hooks/hooks.json, skills/)
//
// 所有下游消费者（hooks / skills / MCP …）一律调 discoverDirs(cwd) 拿
// 同一份 DiscoveryResult，不要各自再扫一遍文件系统。

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";
import type { DiscoveryResult, PluginEntry, SettingsJson } from "./types.js";

const SETTINGS_JSON = "settings.json";
const PLUGINS_JSON = "plugins.json";
const CLAUDE_DIR = ".claude";

const discoveryCache = new Map<string, DiscoveryResult>();

export function clearDiscoveryCache(cwd?: string): void {
  if (cwd) discoveryCache.delete(cwd);
  else discoveryCache.clear();
}

/**
 * 解析给定 cwd 的所有配置目录。结果按 cwd 缓存，本会话内重复调用零开销。
 */
export function discoverDirs(cwd: string): DiscoveryResult {
  const cached = discoveryCache.get(cwd);
  if (cached) return cached;

  const userDir = join(homedir(), CLAUDE_DIR);
  const projectDir = join(cwd, CLAUDE_DIR);

  // 1. 两级 settings.json（缺省返回 null）
  const userSettings = loadSettingsJson(join(userDir, SETTINGS_JSON));
  const projectSettings = loadSettingsJson(join(projectDir, SETTINGS_JSON));

  // 2. plugins.json —— first-found-wins：项目级优先，否则用户级
  const plugins = loadPluginsJson(
    join(projectDir, PLUGINS_JSON),
    cwd,
  ) ?? loadPluginsJson(
    join(userDir, PLUGINS_JSON),
    homedir(),
  ) ?? [];

  const result: DiscoveryResult = {
    userDir,
    projectDir,
    userSettings,
    projectSettings,
    plugins,
  };

  discoveryCache.set(cwd, result);
  log.info("discovery: resolved", {
    cwd,
    userDir,
    projectDir,
    hasUserSettings: !!userSettings,
    hasProjectSettings: !!projectSettings,
    pluginCount: plugins.length,
  });

  return result;
}

// ── settings.json reader ────────────────────────────────────────────

function loadSettingsJson(filePath: string): SettingsJson | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SettingsJson;
    }
    log.warn("discovery: settings.json is not an object", { filePath });
    return null;
  } catch (e) {
    log.warn("discovery: failed to parse settings.json", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ── plugins.json reader ─────────────────────────────────────────────

/**
 * 解析 .claude/plugins.json 为 PluginEntry[]。
 * 路径规范化：相对路径以 basePath 为基准 resolve 到绝对路径。
 * 文件不存在或解析失败一律返回 null（让上层走 first-found-wins 链）。
 */
function loadPluginsJson(
  filePath: string,
  basePath: string,
): PluginEntry[] | null {
  if (!existsSync(filePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    log.warn("discovery: failed to parse plugins.json", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  if (!Array.isArray(parsed)) {
    log.warn("discovery: plugins.json is not an array", { filePath });
    return null;
  }

  const entries: PluginEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["path"] !== "string" || !e["path"]) continue;

    const rawPath = e["path"] as string;
    const absPath = isAbsolute(rawPath)
      ? rawPath
      : resolve(basePath, rawPath);

    entries.push({
      root: absPath,
      enabled: e["enabled"] !== false,
      ...(e["skills"] && typeof e["skills"] === "object"
        ? { skills: e["skills"] as Record<string, boolean> }
        : {}),
    });
  }

  log.info("discovery: plugins.json loaded", {
    filePath,
    count: entries.length,
  });
  return entries;
}
