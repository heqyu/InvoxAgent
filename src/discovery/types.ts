// Discovery 子系统 —— 三级配置目录的统一入口的类型定义。
//
// 设计选择：把 hook wire-format 类型放在这里（而非从 plugins/hooks.ts
// import）是为了打破设计循环：discovery/types → plugins/hooks → discovery/index。
// 这些类型与 hooks.ts 里的形状完全一致，对应 settings.json / hooks.json
// 文件中实际出现的 JSON 结构。

// ── Hook wire-format ────────────────────────────────────────────────

/** hook group 中的一条 shell 命令。 */
export interface HookCommand {
  type: "command";
  command: string;
  /** 超时秒数；默认无限制。 */
  timeout?: number;
  /** true 表示 fire-and-forget，结果被忽略。 */
  async?: boolean;
}

/**
 * 一组 hook 命令 + 可选 matcher。
 * settings.json 与 hooks.json 都用这个 wire 形状。
 */
export interface HookGroup {
  /** 按 tool name 过滤的正则（仅 PreToolUse / PostToolUse 生效）。 */
  matcher?: string;
  description?: string;
  hooks: HookCommand[];
}

// ── Plugin entry（来自 .claude/plugins.json）─────────────────────────

/**
 * 一条已解析的 plugin 目录条目。
 *
 * 设计选择：保留 plugins.json 的全部字段，下游消费者就不必再次读文件。
 */
export interface PluginEntry {
  /** plugin 根目录的绝对路径。 */
  root: string;
  /** 是否启用；默认 true。 */
  enabled: boolean;
  /** 单 skill 的开关；undefined 表示全部启用。 */
  skills?: Record<string, boolean>;
}

// ── settings.json ───────────────────────────────────────────────────

/**
 * 我们关心的 settings.json 字段；不建模 Claude Code 全部 schema。
 *
 * 设计选择：hooks 复用 HookGroup[]（schema 完全一致）；
 * mcpServers 留 opaque 类型，由消费者按需归一化。
 */
export interface SettingsJson {
  hooks?: Record<string, HookGroup[]>;
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

// ── DiscoveryResult ─────────────────────────────────────────────────

/** discoverDirs(cwd) 的输出，下游所有消费者从这里取数据。 */
export interface DiscoveryResult {
  /** ~/.claude —— 用户级配置目录。 */
  userDir: string;
  /** <cwd>/.claude —— 项目级配置目录。 */
  projectDir: string;

  /** 用户级 settings.json 内容（不存在为 null）。 */
  userSettings: SettingsJson | null;
  /** 项目级 settings.json 内容（不存在为 null）。 */
  projectSettings: SettingsJson | null;

  /**
   * 来自 .claude/plugins.json 的已解析 plugin 列表。
   *
   * 设计选择：first-found-wins —— 项目级 plugins.json 存在时跳过用户级，
   * 与 loader.ts 既有行为一致。
   */
  plugins: PluginEntry[];
}
