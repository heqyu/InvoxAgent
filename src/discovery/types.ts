// Discovery module types.
//
// Three-tier discovery: user (~/.claude) → project (<cwd>/.claude) → plugins.
// All consumers (skills, hooks, MCP, etc.) derive their data from a single
// DiscoveryResult rather than independently re-scanning the filesystem.

// ── Hook wire-format types ─────────────────────────────────────────
//
// CHOICE: Define the hook JSON wire-format types here (not imported from
// plugins/hooks.ts) to break a design cycle: discovery/types → plugins/hooks
// → discovery/index. These types mirror the shapes in hooks.ts exactly and
// represent what appears in settings.json and hooks.json files.

/** One shell command inside a hook group. */
export interface HookCommand {
  type: "command";
  command: string;
  /** Timeout in seconds. Default: no limit. */
  timeout?: number;
  /** If true, fire-and-forget — process result is ignored. */
  async?: boolean;
}

/**
 * A group of hook commands with an optional matcher.
 * This is the wire-format shape found in both settings.json and hooks.json.
 */
export interface HookGroup {
  /** Regex pattern to filter by tool name (PreToolUse / PostToolUse only). */
  matcher?: string;
  description?: string;
  hooks: HookCommand[];
}

// ── Plugin entry (resolved from .claude/plugins.json) ────────────────

/**
 * One resolved plugin directory.
 *
 * CHOICE: We keep the full PluginConfig shape (from plugins.json) so
 * downstream consumers have all the metadata they need without re-parsing.
 */
export interface PluginEntry {
  /** Absolute path to the plugin root directory. */
  root: string;
  /** Whether this plugin is enabled. Default: true. */
  enabled: boolean;
  /** Per-skill enable/disable toggle. Undefined = all enabled. */
  skills?: Record<string, boolean>;
}

// ── Settings.json shape ─────────────────────────────────────────────

/**
 * The fields we extract from settings.json. We do NOT model the full
 * Claude Code settings schema — only the parts invox consumes.
 *
 * CHOICE: hooks use the existing HookGroup[] type (identical schema).
 * mcpServers uses an opaque Record because the user/project formats
 * differ and will be normalized by the consumer.
 */
export interface SettingsJson {
  hooks?: Record<string, HookGroup[]>;
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

// ── Discovery result ────────────────────────────────────────────────

/**
 * The output of DiscoverDirs(cwd). Provides everything downstream
 * consumers need to load their specific resources.
 */
export interface DiscoveryResult {
  // ── Resolved directories ──────────────────────────────────────────
  /** ~/.claude — the user-level config directory. */
  userDir: string;
  /** <cwd>/.claude — the project-level config directory. */
  projectDir: string;

  // ── Raw settings (user settings loaded first, project overrides) ──
  /** User-level settings.json contents (null if absent). */
  userSettings: SettingsJson | null;
  /** Project-level settings.json contents (null if absent). */
  projectSettings: SettingsJson | null;

  // ── Plugins ───────────────────────────────────────────────────────
  /**
   * Resolved plugin entries from .claude/plugins.json.
   *
   * CHOICE: first-found-wins — if project plugins.json exists, user-level
   * is skipped (matches existing behavior in loader.ts loadConfigs).
   */
  plugins: PluginEntry[];
}
