// 插件 hook 系统 —— 通过 shell 命令订阅生命周期事件。
// 协议参考 Claude Code / CodeBuddy。
//
// Hook 触发点：
//   SessionStart       —— 新会话创建后
//   UserPromptSubmit   —— 用户提交 prompt 时
//   PreToolUse         —— 工具执行前
//   PostToolUse        —— 工具执行成功后
//   PostToolUseFailure —— 工具执行失败后
//   Stop               —— agent loop 自然结束时
//
// 配置文件：<pluginRoot>/hooks/hooks.json
//   {
//     "hooks": {
//       "SessionStart": [
//         {
//           "hooks": [
//             { "type": "command", "command": "bash script.sh", "timeout": 5, "async": false }
//           ]
//         }
//       ],
//       "PreToolUse": [
//         { "matcher": "Write|Edit", "hooks": [ ... ] }
//       ]
//     }
//   }
//
// 每条 hook 命令把 context 作为 JSON 写入 stdin，从 stdout 读 JSON 返回：
//   { "continue": true, "systemMessage": "..." }
// 退出码 2 表示"阻塞操作"（拒绝工具 / 阻止结束）。
// async: true 则 fire-and-forget，结果忽略。
// matcher 仅 PreToolUse / PostToolUse 生效，按 tool name 正则过滤。

import { createLogger } from "../log.js";
const log = createLogger("plugins");
import { discoverDirs } from "../discovery/index.js";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ── Hook 配置类型 ───────────────────────────────────────────────────

export interface HookCommand {
  type: "command";
  command: string;
  /** 超时秒数；默认无限制。 */
  timeout?: number;
  /** true 表示 fire-and-forget，结果忽略。 */
  async?: boolean;
}

export interface HookGroup {
  /** 按 tool name 过滤的正则（仅 PreToolUse / PostToolUse 生效）。 */
  matcher?: string;
  description?: string;
  hooks: HookCommand[];
}

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

// ── 写到 hook stdin 的 context 类型 ────────────────────────────────

export interface HookContextBase {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  /** 当前会话使用的 LLM model id。 */
  model: string;
  /** ACP initialize 时上报的客户端名（如 "Zed"、"Claude Code"）。 */
  client: string;
  /** invox 自身的 package 版本。 */
  version: string;
}

export interface SessionStartCtx extends HookContextBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume";
}

export interface UserPromptSubmitCtx extends HookContextBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseCtx extends HookContextBase {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseCtx extends HookContextBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

export interface PostToolUseFailureCtx extends HookContextBase {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

export interface StopCtx extends HookContextBase {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
}

export type HookContext =
  | SessionStartCtx
  | UserPromptSubmitCtx
  | PreToolUseCtx
  | PostToolUseCtx
  | PostToolUseFailureCtx
  | StopCtx;

// ── Hook 命令的 stdout JSON ────────────────────────────────────────

export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  systemMessage?: string;
  /**
   * Claude Code 约定：Stop hook 阻塞时，reason 是要注入回话的指令文本，
   * 让 agent 知道下一步该做什么。
   * Claude Code 直接读 reason；invox 在 runHookCommand 的 decision:"block"
   * 分支里把它合并进 systemMessage，让 agent.ts 的现有 Stop 处理逻辑
   * 透明拿到。
   */
  reason?: string;
  /**
   * Claude Code / CodeBuddy 约定：PreToolUse hook 可通过
   * hookSpecificOutput.modifiedInput 修改工具参数。
   *
   * 例如 inject-env hook 会在 Bash 命令前注入环境变量 export：
   *   modifiedInput: { command: "export ...; original_cmd" }
   *
   * Invox 在 runPreToolUse 返回后、工具执行前，将 modifiedInput 合并
   * 到 toolArgs 中，让 Bash 工具拿到改写后的命令。
   */
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    modifiedInput?: Record<string, unknown>;
  };
}

// ── 已解析的 hook 组（含归属 plugin）─────────────────────────────────

export interface ResolvedHookGroup {
  pluginRoot: string;
  pluginName: string;
  description?: string;
  matcher?: string;
  hooks: HookCommand[];
}

// ── HookRegistry ────────────────────────────────────────────────────

export class HookRegistry {
  sessionStart: ResolvedHookGroup[] = [];
  userPromptSubmit: ResolvedHookGroup[] = [];
  preToolUse: ResolvedHookGroup[] = [];
  postToolUse: ResolvedHookGroup[] = [];
  postToolUseFailure: ResolvedHookGroup[] = [];
  stop: ResolvedHookGroup[] = [];
}

const hookCache = new Map<string, HookRegistry>();

/**
 * 加载三层 hook：用户 settings.json + 项目 settings.json + 各 plugin 的 hooks.json。
 * 按 cwd 缓存。
 *
 * 合并顺序（低 → 高优先级）：
 *   1. 用户 settings.json
 *   2. 项目 settings.json
 *   3. 各启用 plugin 的 hooks/hooks.json
 *
 * 设计选择：同事件下的 hook group 是追加（不替换），与 Claude Code 一致 ——
 * 所有匹配的 hook 都会跑。
 */
export function loadHooks(cwd: string): HookRegistry {
  const cached = hookCache.get(cwd);
  if (cached) return cached;

  const registry = new HookRegistry();
  const discovery = discoverDirs(cwd);

  // 1. 用户 settings.json hooks
  if (discovery.userSettings?.hooks) {
    mergeSettingsHooks(discovery.userSettings.hooks, registry, "user settings");
  }

  // 2. 项目 settings.json hooks
  if (discovery.projectSettings?.hooks) {
    mergeSettingsHooks(
      discovery.projectSettings.hooks,
      registry,
      "project settings",
    );
  }

  // 3. plugin hooks.json（仅启用的 plugin）
  for (const plugin of discovery.plugins) {
    if (!plugin.enabled) continue;
    loadHooksFromPlugin(plugin.root, registry);
  }

  hookCache.set(cwd, registry);
  return registry;
}

export function clearHookCache(cwd?: string): void {
  if (cwd) hookCache.delete(cwd);
  else hookCache.clear();
}

// ── settings.json 中的 hooks 合并 ───────────────────────────────────

/**
 * 事件名 → registry 数组的映射。
 * 设计选择：实现成函数而非常量 —— 避免 registry 被外部修改后映射失效。
 */
function registryMap(
  registry: HookRegistry,
): Record<string, ResolvedHookGroup[]> {
  return {
    SessionStart: registry.sessionStart,
    UserPromptSubmit: registry.userPromptSubmit,
    PreToolUse: registry.preToolUse,
    PostToolUse: registry.postToolUse,
    PostToolUseFailure: registry.postToolUseFailure,
    Stop: registry.stop,
  };
}

// ── hook group 解析 & 合并（settings / plugin 共用）────────────────

interface HookSource {
  kind: "settings" | "plugin";
  /** 日志标签： "user settings" / "project settings" / pluginName */
  label: string;
  /** plugin 的根目录；settings 来源无此项。 */
  pluginRoot?: string;
}

/**
 * 把单个 hook group 对象解析为已验证的 ResolvedHookGroup。
 * 解析失败（缺少 hooks 数组 / 无有效命令）返回 null。
 */
function parseHookGroup(
  group: unknown,
  pluginRoot: string,
  pluginName: string,
): ResolvedHookGroup | null {
  if (!group || typeof group !== "object") return null;
  const g = group as Record<string, unknown>;
  const hookCommands = g["hooks"];
  if (!Array.isArray(hookCommands)) return null;

  const commands: HookCommand[] = [];
  for (const h of hookCommands) {
    if (!h || typeof h !== "object") continue;
    const cmd = h as Record<string, unknown>;
    if (cmd["type"] !== "command") continue;
    if (typeof cmd["command"] !== "string" || !cmd["command"]) continue;
    commands.push({
      type: "command",
      command: cmd["command"] as string,
      timeout:
        typeof cmd["timeout"] === "number" ? cmd["timeout"] : undefined,
      async: cmd["async"] === true,
    });
  }

  if (commands.length === 0) return null;

  return {
    pluginRoot,
    pluginName,
    description:
      typeof g["description"] === "string" ? g["description"] : undefined,
    matcher: typeof g["matcher"] === "string" ? g["matcher"] : undefined,
    hooks: commands,
  };
}

/**
 * 把一组 events → groups 映射合并进 registry。
 * settings.json 和 plugin hooks.json 共用此逻辑，仅日志标签不同。
 */
function mergeHookGroupMap(
  groups: Record<string, unknown>,
  registry: HookRegistry,
  source: HookSource,
): void {
  const map = registryMap(registry);
  const pluginRoot = source.pluginRoot ?? "";
  const pluginName = source.label;

  for (const [eventName, groupList] of Object.entries(groups)) {
    const target = map[eventName];
    if (!target) {
      log.warn(
        source.kind === "settings"
          ? "discovery: unknown hook event in settings.json"
          : "plugins: unknown hook event in hooks.json",
        {
          eventName,
          ...(source.kind === "plugin"
            ? { path: source.pluginRoot }
            : { source: source.label }),
        },
      );
      continue;
    }
    if (!Array.isArray(groupList)) continue;

    for (const group of groupList) {
      const parsed = parseHookGroup(group, pluginRoot, pluginName);
      if (parsed) target.push(parsed);
    }
  }
}

// ── settings.json 合并入口 ──────────────────────────────────────────

/**
 * 把 settings.json 中的 hooks 字段合并进 registry。
 * settings.json 的 hooks 字段与 hooks.json 同 wire 格式：
 *   { "EventName": [{ "matcher": "...", "hooks": [{ "type": "command", ... }] }] }
 *
 * @param settingsHooks settings.json 的 hooks 对象
 * @param registry      合并目标
 * @param source        日志标签（"user settings" / "project settings"）
 */
function mergeSettingsHooks(
  settingsHooks: Record<string, unknown>,
  registry: HookRegistry,
  source: string,
): void {
  mergeHookGroupMap(settingsHooks, registry, { kind: "settings", label: source });
}

// ── plugin hooks 加载 ───────────────────────────────────────────────

function loadHooksFromPlugin(pluginRoot: string, registry: HookRegistry): void {
  const hooksJsonPath = join(pluginRoot, "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch (e) {
    log.warn("plugins: failed to parse hooks.json", {
      path: hooksJsonPath,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  if (!raw || typeof raw !== "object") return;
  const config = raw as Record<string, unknown>;
  const hooks = config["hooks"];
  if (!hooks || typeof hooks !== "object") return;

  const pluginName = loadPluginName(pluginRoot);

  mergeHookGroupMap(hooks as Record<string, unknown>, registry, {
    kind: "plugin",
    label: pluginName,
    pluginRoot,
  });
}

function loadPluginName(pluginRoot: string): string {
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (raw && typeof raw === "object" && "name" in raw) {
      return String(raw["name"]);
    }
  } catch {
    // 退到目录名
  }
  const sep = pluginRoot.includes("\\") ? "\\" : "/";
  const parts = pluginRoot.replace(/[\\/]+$/, "").split(sep);
  return parts[parts.length - 1] ?? pluginRoot;
}

// ── matcher 工具 ────────────────────────────────────────────────────

/**
 * 判定 toolName 是否匹配 hook group 的 matcher 正则。
 *
 * 设计要点：
 *   - matcher 为空 / undefined → 全匹配（default-allow）
 *   - 非法正则不抛错 —— 退化为字面量精确匹配，避免单条错误配置弄挂整个
 *     hook 系统
 *   - 正则未锚定（不带 ^...$）—— 与 Claude Code 一致：含子串即匹配
 */
export function matchesTool(
  matcher: string | undefined,
  toolName: string,
): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // 非法正则 → 字面量比较
    return matcher === toolName;
  }
}

// ── 对外 hook 触发函数 ──────────────────────────────────────────────

// runHooks 从 hooks-runner.ts 导入
import { runHooks } from "./hooks-runner.js";

export async function runSessionStart(
  registry: HookRegistry | undefined,
  ctx: SessionStartCtx,
): Promise<void> {
  if (!registry?.sessionStart.length) return;
  // SessionStart hook 是 fire-and-forget，不阻塞会话创建
  await runHooks(registry, ctx).catch(() => {});
}

export async function runUserPromptSubmit(
  registry: HookRegistry | undefined,
  ctx: UserPromptSubmitCtx,
): Promise<{ continue: boolean; systemMessage?: string }> {
  const result = await runHooks(registry, ctx);
  return {
    continue: result.continue !== false,
    systemMessage: result.systemMessage,
  };
}

export async function runPreToolUse(
  registry: HookRegistry | undefined,
  ctx: PreToolUseCtx,
): Promise<{
  allow: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  if (result.continue === false) {
    return { allow: false, reason: result.systemMessage ?? "blocked by hook" };
  }
  return {
    allow: true,
    ...(result.hookSpecificOutput?.modifiedInput
      ? { modifiedInput: result.hookSpecificOutput.modifiedInput }
      : {}),
  };
}

export async function runPostToolUse(
  registry: HookRegistry | undefined,
  ctx: PostToolUseCtx,
): Promise<{ systemMessage?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  return { systemMessage: result.systemMessage };
}

export async function runPostToolUseFailure(
  registry: HookRegistry | undefined,
  ctx: PostToolUseFailureCtx,
): Promise<{ systemMessage?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  return { systemMessage: result.systemMessage };
}

export async function runStop(
  registry: HookRegistry | undefined,
  ctx: StopCtx,
): Promise<{ continue: boolean; systemMessage?: string }> {
  const result = await runHooks(registry, ctx);
  return {
    continue: result.continue !== false,
    systemMessage: result.systemMessage,
  };
}
