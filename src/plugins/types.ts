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
}
