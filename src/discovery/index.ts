// Discovery module — three-tier config directory resolution.
//
// Discovers and loads configuration from three sources (lowest → highest):
//   1. User:    ~/.claude/                   (settings.json, plugins.json)
//   2. Project: <cwd>/.claude/               (settings.json, plugins.json)
//   3. Plugins: directories listed in plugins.json (hooks/hooks.json, skills/)
//
// All downstream consumers (hooks, skills, MCP, etc.) should call
// discoverDirs(cwd) to get a unified DiscoveryResult rather than
// independently re-scanning the filesystem.

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";
import type { DiscoveryResult, PluginEntry, SettingsJson } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────

const SETTINGS_JSON = "settings.json";
const PLUGINS_JSON = "plugins.json";
const CLAUDE_DIR = ".claude";

// ── Cache ───────────────────────────────────────────────────────────

const discoveryCache = new Map<string, DiscoveryResult>();

export function clearDiscoveryCache(cwd?: string): void {
  if (cwd) discoveryCache.delete(cwd);
  else discoveryCache.clear();
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Discover all configuration directories for the given cwd.
 *
 * Result is cached — repeated calls within the same session skip
 * re-scanning the filesystem.
 */
export function discoverDirs(cwd: string): DiscoveryResult {
  const cached = discoveryCache.get(cwd);
  if (cached) return cached;

  const userDir = join(homedir(), CLAUDE_DIR);
  const projectDir = join(cwd, CLAUDE_DIR);

  // 1. Load settings.json from both levels (null if absent)
  const userSettings = loadSettingsJson(join(userDir, SETTINGS_JSON));
  const projectSettings = loadSettingsJson(join(projectDir, SETTINGS_JSON));

  // 2. Load plugins.json (first-found-wins: project → user)
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

// ── Settings.json reader ────────────────────────────────────────────

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

// ── Plugins.json reader ─────────────────────────────────────────────

/**
 * Parse .claude/plugins.json into PluginEntry[].
 *
 * CHOICE: Replicates the existing loadConfigs() path-normalization logic
 * (relative paths resolved against basePath) to ensure backward compat.
 *
 * Returns null if the file doesn't exist or is unparseable.
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
