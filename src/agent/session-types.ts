// agent 子系统的类型定义集合 —— 纯类型，零运行时依赖。
//
// 抽出的目的（A2）：
//   - 把 agent.ts 的胖文件减重，类型独立可复用
//   - 让 prompt-loop / replay-history / turn-usage-reporter 等
//     新模块不必再 `import { type Session } from "./agent.js"`
//     造成循环依赖
//
// 接口语义在搬家前后完全一致；任何字段变更应同步更新 PLAN.md §1。

import type { ModelInfo } from "@agentclientprotocol/sdk";
import type { LLMMessage } from "../llm/types.js";
import type { McpClientManager } from "../mcp/client.js";
import type { SessionStore } from "../persistence.js";
import type { SessionToolState } from "../tools/types.js";
import type { HookRegistry } from "../plugins/hooks.js";
import type { TurnUsage } from "./usage-meter.js";

/**
 * 一个活动会话。每次 `session/new` 创建一份；`session/load` 从磁盘
 * 复活一份。同 cwd 的多个 session 共享 MCP 池，但各自有独立的
 * abort、history、tool 状态、turn 计费。
 */
export interface Session {
  id: string;
  cwd: string;
  history: LLMMessage[];
  abort: AbortController;
  toolState: SessionToolState;
  store?: SessionStore;
  createdAt: number;
  /**
   * 通过 unstable_setSessionModel 选定的 model id。
   * undefined 时回退到 agent 默认 model（availableModels[0]，源自 INVOX_MODEL）。
   */
  selectedModel?: string;
  /**
   * 按 configId 索引的会话级配置值，驱动 ACP setSessionConfigOption 的下拉项。
   * 值类型恒为 string（当前只产出 select kind）。
   *
   * InvoxAgent 内部管理的保留 key：
   *   - "system_prompt" —— 当前 system prompt 模板的 id
   *   - "thinking"      —— "off" | "low" | "medium" | "high"
   *                        （请求时映射到 OpenAI 的 reasoning_effort 字段）
   */
  configValues: Record<string, string>;
  /**
   * 当前 prompt() turn 内累计的 token 计费；进入 prompt() 时重置。
   * turn 末尾通过 agent_thought_chunk + `invox/usage` _meta 扩展上报给客户端。
   */
  turnUsage: TurnUsage;
  /** prompt() 起始的 wall-clock ms —— 用来算 turn 耗时。 */
  turnStartedAt: number;
  /** MCP client manager —— 持有该会话连接的 MCP servers。 */
  mcpClient?: McpClientManager;
  /**
   * 本会话生效的 hook 注册表。在 newSession / loadSession 时一次性加载并
   * 缓存到 session 上，prompt loop / 各 hook 触发点全部走 `session.hooks`，
   * 不再反复 `loadHooks(cwd)`。底层 hookCache 仍按 cwd 缓存，但显式持有
   * 引用让代码意图更清晰、单测注入更容易。
   */
  hooks: HookRegistry;
  /**
   * 上一次完成的 turn 用量持久化快照，重启后保留，让 reloadSession 后用户
   * 仍能看到上一轮花了多少。
   */
  lastTurnUsage?: PersistedTurnUsage;
}

/**
 * 持久化版的 lastTurnUsage 形状 —— 比内存版 `TurnUsage` 多两个字段
 * （elapsedMs、model）以便重启后渲染"耗时 + 用了哪个模型"。
 */
export interface PersistedTurnUsage {
  input: number;
  output: number;
  total: number;
  calls: number;
  maxPrompt: number;
  maxCached: number;
  cached: number;
  elapsedMs: number;
  model: string;
}

/** 构造 InvoxAgent 时注入的 model 菜单配置。第一项是默认 model。 */
export interface AgentModelConfig {
  /** 对客户端公布的 model 列表，必须非空。 */
  available: ModelInfo[];
  /** 默认 model id，必须在 available 中。会话尚未通过 setSessionModel 选择
   *  model 时使用。 */
  defaultModelId: string;
}

/**
 * 系统提示词菜单中的一行 —— 渲染为 ACP `select` kind 的 SessionConfigOption
 * （id="system_prompt"）。选中某行会替换 Session.history[0] 为 prompt 文本。
 */
export interface SystemPromptDef {
  /** 唯一稳定 id，作为 SessionConfigSelectOption.value。 */
  id: string;
  /** 下拉菜单显示的可读名。 */
  name: string;
  /** 鼠标悬浮提示（可选）。 */
  description?: string;
  /** 真正注入到 history[0] 的 system message 文本。 */
  prompt: string;
}

/**
 * model 选择器之外的全部下拉项配置。
 * 当前包括：system prompt 模板。
 *
 * thinking 选项是硬编码的（off / low / medium / high，对应 OpenAI 的
 * reasoning_effort）—— 取值由上游 API 决定，不开 env 调参。
 */
export interface AgentConfigOptions {
  systemPrompts: SystemPromptDef[];
  /** 必须是 systemPrompts[*].id 之一。 */
  defaultSystemPromptId: string;
}

/**
 * 各 hook 通用的 base 字段集合。`InvoxAgent.hookBase()` 构造，传给
 * 散落的 free function（prompt-loop 等），避免那些函数依赖 InvoxAgent 实例。
 */
export interface HookBase {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  model: string;
  client: string;
  version: string;
}
