// Plugin system types — simplified design.
//
// Config file: .claude/plugins.json
// Plugin dir:  <path>/.claude-plugin/plugin.json + skills/*/SKILL.md

/**
 * One entry in the .claude/plugins.json array.
 */
export interface PluginConfig {
  /** Absolute or cwd-relative path to the plugin root directory. */
  path: string;
  /** Whether this plugin is enabled. Default: true. */
  enabled?: boolean;
  /**
   * Per-skill enable/disable toggle.  Keys are skill directory names.
   * If omitted, all skills in the plugin are loaded.
   * If present, only skills explicitly set to `true` are loaded.
   */
  skills?: Record<string, boolean>;
}

/**
 * Shape of `<pluginRoot>/.claude-plugin/plugin.json`.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: { name: string };
  keywords?: string[];
  /**
   * Hook declarations. Keys are hook event names (e.g. "SessionStart",
   * "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"). Values
   * are paths relative to the plugin root pointing to JS modules that
   * export a default async function handling the hook.
   */
  hooks?: Record<string, string>;
}

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
