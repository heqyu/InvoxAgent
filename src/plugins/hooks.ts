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

import { spawn } from "node:child_process";
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
  const map = registryMap(registry);

  for (const [eventName, groups] of Object.entries(settingsHooks)) {
    const target = map[eventName];
    if (!target) {
      log.warn("discovery: unknown hook event in settings.json", {
        eventName,
        source,
      });
      continue;
    }
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const hookCommands = g["hooks"];
      if (!Array.isArray(hookCommands)) continue;

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

      if (commands.length === 0) continue;

      target.push({
        pluginRoot: "", // settings.json hooks 没有 plugin root
        pluginName: source,
        description:
          typeof g["description"] === "string" ? g["description"] : undefined,
        matcher: typeof g["matcher"] === "string" ? g["matcher"] : undefined,
        hooks: commands,
      });
    }
  }
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

  // 事件名 → registry 数组
  const registryMap: Record<string, ResolvedHookGroup[]> = {
    SessionStart: registry.sessionStart,
    UserPromptSubmit: registry.userPromptSubmit,
    PreToolUse: registry.preToolUse,
    PostToolUse: registry.postToolUse,
    PostToolUseFailure: registry.postToolUseFailure,
    Stop: registry.stop,
  };

  for (const [eventName, groups] of Object.entries(
    hooks as Record<string, unknown>,
  )) {
    const target = registryMap[eventName];
    if (!target) {
      log.warn("plugins: unknown hook event in hooks.json", {
        eventName,
        path: hooksJsonPath,
      });
      continue;
    }

    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const hookCommands = g["hooks"];
      if (!Array.isArray(hookCommands)) continue;

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

      if (commands.length === 0) continue;

      target.push({
        pluginRoot,
        pluginName,
        description:
          typeof g["description"] === "string" ? g["description"] : undefined,
        matcher: typeof g["matcher"] === "string" ? g["matcher"] : undefined,
        hooks: commands,
      });
    }
  }
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

// ── Hook 命令执行 ───────────────────────────────────────────────────

/**
 * 执行单条 hook 命令：context 写入 stdin，从 stdout 解析 JSON 响应。
 * 返回：解析后的 HookResponse + 退出码 + stderr 文本。
 * 命令是 async（fire-and-forget）或失败时 response 为 null。
 */
function runHookCommand(
  cmd: HookCommand,
  jsonCtx: string,
  pluginRoot: string,
  hookEvent: string,
  timeoutMs?: number,
): Promise<{
  response: HookResponse | null;
  exitCode: number | null;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, {
      shell: true,
      cwd: pluginRoot,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CODEBUDDY_PLUGIN_ROOT: pluginRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (!resolved) {
            resolved = true;
            child.kill();
            log.warn("plugins: hook command timed out", {
              command: cmd.command.substring(0, 120),
              hookEvent,
              timeoutMs,
            });
            resolve({ response: null, exitCode: null, stderr: "timeout" });
          }
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        log.warn("plugins: hook command spawn failed", {
          command: cmd.command.substring(0, 120),
          hookEvent,
          error: err.message,
        });
        resolve({ response: null, exitCode: null, stderr: err.message });
      }
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);

      // Claude Code 规范：「退出码 2 表示阻塞错误。Claude Code 忽略 stdout，
      // 任何 stdout 中的 JSON 都不解析；改用 stderr 文本作为错误说明。」
      // 所以必须先看 exit code 再决定是否解析 stdout。
      let response: HookResponse | null = null;

      if (code === 2) {
        // 退出码 2 = 阻塞信号，stdout 按规范忽略。stderr 是给人看的原因。
        const errText = stderr.trim();
        response = {
          continue: false,
          reason: errText || `blocked by ${hookEvent} hook`,
          systemMessage: errText || `blocked by ${hookEvent} hook`,
        };
      } else if (stdout.trim()) {
        // 退出码 0 或其他：尝试解析 stdout JSON 作为结构化指令
        try {
          response = JSON.parse(stdout.trim()) as HookResponse;
          // 归一化 Claude Code 约定：decision → continue
          if (
            response &&
            typeof (response as Record<string, unknown>).decision === "string"
          ) {
            const decision = (response as Record<string, unknown>)
              .decision as string;
            if (decision === "block" && response.continue === undefined) {
              response.continue = false;
              // reason 是注入回会话的指令文本，让 agent 知道接下来该做什么
              if (response.reason && response.reason.length > 0) {
                response.systemMessage = response.reason;
              }
            } else if (
              decision === "allow" &&
              response.continue === undefined
            ) {
              response.continue = true;
            }
          }
        } catch {
          // 非 JSON stdout 忽略（debug 输出等）
        }
      }

      log.debug("hook stdout", {
        hookEvent,
        command: cmd.command.substring(0, 120),
        exitCode: code,
        stdout: stdout.trim().substring(0, 500),
        stderr: stderr.trim().substring(0, 200),
        parsedResponse: response,
      });

      resolve({ response, exitCode: code, stderr });
    });

    // 把 context JSON 写到 stdin 并关闭
    log.debug("hook stdin", {
      hookEvent,
      command: cmd.command.substring(0, 120),
      stdin: jsonCtx.trim(),
    });
    child.stdin.write(jsonCtx);
    child.stdin.end();
  });
}

/**
 * 把命令字符串里的 ${CLAUDE_PLUGIN_ROOT} / ${CODEBUDDY_PLUGIN_ROOT}
 * 替换成实际 plugin 根目录。
 */
function resolveEnvInCommand(command: string, pluginRoot: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CODEBUDDY_PLUGIN_ROOT\}/g, pluginRoot);
}

// ── Hook runner（agent.ts 调用入口）─────────────────────────────────

/** 收集事件下的 hook group 并按 toolName 过滤 matcher。 */
function collectGroups(
  registry: HookRegistry | undefined,
  event: HookEventName,
  toolName?: string,
): ResolvedHookGroup[] {
  if (!registry) return [];

  const groups: ResolvedHookGroup[] =
    (registry as Record<string, any>)[eventKey(event)] ?? [];

  if (!toolName) return groups;

  return groups.filter((g) => matchesTool(g.matcher, toolName));
}

function eventKey(event: HookEventName): string {
  switch (event) {
    case "SessionStart":
      return "sessionStart";
    case "UserPromptSubmit":
      return "userPromptSubmit";
    case "PreToolUse":
      return "preToolUse";
    case "PostToolUse":
      return "postToolUse";
    case "PostToolUseFailure":
      return "postToolUseFailure";
    case "Stop":
      return "stop";
  }
}

/**
 * 跑事件下匹配的所有 hook 命令：
 * - async 命令后台 spawn 不等
 * - 同步命令 await 后聚合结果；首个 continue=false 立即停下，返回带 reason 的聚合
 */
async function runHooks(
  registry: HookRegistry | undefined,
  ctx: HookContext,
  toolName?: string,
): Promise<HookResponse> {
  const groups = collectGroups(registry, ctx.hook_event_name, toolName);
  if (groups.length === 0) return { continue: true };

  const jsonCtx = JSON.stringify(ctx) + "\n";
  const agg: HookResponse = { continue: true };
  const systemMessages: string[] = [];

  for (const group of groups) {
    for (const cmd of group.hooks) {
      const resolvedCmd = resolveEnvInCommand(cmd.command, group.pluginRoot);
      const timeoutMs = cmd.timeout ? cmd.timeout * 1000 : undefined;

      if (cmd.async) {
        // fire-and-forget：spawn 但不 await
        runHookCommand(
          { ...cmd, command: resolvedCmd },
          jsonCtx,
          group.pluginRoot,
          ctx.hook_event_name,
          timeoutMs,
        ).catch(() => {});
        continue;
      }

      try {
        const { response } = await runHookCommand(
          { ...cmd, command: resolvedCmd },
          jsonCtx,
          group.pluginRoot,
          ctx.hook_event_name,
          timeoutMs,
        );

        if (response) {
          if (response.continue === false) {
            agg.continue = false;
            // Claude Code 规范：一旦阻塞，立即停下后续 hook，第一个阻塞胜出
            if (response.reason) agg.reason = response.reason;
            if (response.systemMessage)
              agg.systemMessage = response.systemMessage;
            return agg;
          }
          if (response.systemMessage)
            systemMessages.push(response.systemMessage);
        }
      } catch (e) {
        log.warn("plugins: hook command failed", {
          hookEvent: ctx.hook_event_name,
          command: resolvedCmd.substring(0, 120),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (systemMessages.length > 0) {
    agg.systemMessage = systemMessages.join("\n\n");
  }
  agg.suppressOutput = systemMessages.length === 0;

  return agg;
}

// ── 对外 hook 触发函数 ──────────────────────────────────────────────

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
): Promise<{ allow: boolean; reason?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  if (result.continue === false) {
    return { allow: false, reason: result.systemMessage ?? "blocked by hook" };
  }
  return { allow: true };
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
