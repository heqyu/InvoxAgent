// 工具子系统共享类型与契约。

import type {
  AgentSideConnection,
  ClientCapabilities,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { ToolSpec } from "../llm/types.js";
import type { FileCache } from "./cache.js";

export type PermissionPolicy = "never" | "writes" | "always";

export type RiskTier = "read" | "write" | "execute";

/**
 * 一个 ACP session 内、跨工具调用共享的状态。
 *
 * 挂在 agent 的 Session 对象上，按引用注入到每次工具调用里。工具会修改它
 * （Read 写入 cache，Edit 失效缓存等），让同一轮内的后续工具看到一致视图。
 */
export interface SessionToolState {
  /** LLM 在本会话中已读过的绝对路径集合 —— Edit 的前置闸门。 */
  readPaths: Set<string>;
  /** 按路径缓存的文件内容（失效规则见 ./cache.ts）。 */
  cache: FileCache;
}

/**
 * SubAgent 调用入口签名 —— 由 prompt-loop 在构造 ToolExecContext 时按需注入。
 *
 * 设计点：
 *   - 类型定义放在 tools/types.ts（而非 agent/）以避免 tools → agent 的反向依赖
 *   - subagent 内部跑一轮完整的 prompt loop，期间可能再触发各种工具；本 runner
 *     的实现在 src/agent/sub-agent-runner.ts，prompt-loop 把闭包注入工具上下文
 *   - 同一会话最多嵌套 1 层：进入 subagent 后 ctx.subAgentRunner 必为 undefined，
 *     防止递归爆炸（见 prompt-loop.ts 的 inSubAgent 分支）
 */
export interface SubAgentRunRequest {
  /** 选用哪个 agent 模板 id（如 "Plan" / "Ask" / "CodeReviewer" / "Worker"）。 */
  subagentType: string;
  /** 作为 subagent 单条 user message 的任务说明文本。 */
  prompt: string;
  /** UI 工具卡显示用的简短任务名（3-5 词）。 */
  description?: string;
  /** 显式 model id 覆盖；优先级高于 agent.model。 */
  modelOverride?: string;
  /**
   * 父 tool_call 的 id —— 用来在 subagent 跑过程中向"父 SubAgent 工具卡"
   * 反馈实时进度（每发起一个内部工具调用就在卡片内追加一行）。
   * SubAgent 工具从 ToolExecContext.toolCallId 拿到后透传过来。
   * 缺省时 runner 不发进度更新（subagent 卡保持 in_progress 等末态覆盖）。
   */
  parentToolCallId?: string;
}

// SubAgentRunResult 的权威定义在 src/agent/sub-agent-runner.ts。
// re-export + local import 让工具子系统使用；用 import type 避免值循环依赖。
import type { SubAgentRunResult } from "../agent/sub-agent/index.js";
export type { SubAgentRunResult } from "../agent/sub-agent/index.js";

export type SubAgentRunner = (
  req: SubAgentRunRequest,
  signal: AbortSignal,
) => Promise<SubAgentRunResult>;

/** 工具 execute() 的运行时上下文。 */
export interface ToolExecContext {
  conn: AgentSideConnection;
  sessionId: string;
  cwd: string;
  caps: ClientCapabilities;
  signal: AbortSignal;
  policy: PermissionPolicy;
  toolCallId: string;
  state: SessionToolState;
  /**
   * 当前激活的 agent 模板 id（如 "BDD" / "Plan" / "Worker"）。
   *
   * 供工具按 agent 做差异化行为（如 MakePlan 在 BDD 模式下校验 Gherkin 段落）。
   * undefined → 旧路径 / 无 agent 上下文。
   */
  activeAgentId?: string;
  /**
   * 启动 subagent 的入口闭包。仅在「parent prompt loop 调用本工具」时存在；
   * 「subagent 内部调用本工具」时为 undefined（避免递归）。
   *
   * SubAgent 工具在自己的 execute() 中读取本字段；其它工具应忽略。
   */
  subAgentRunner?: SubAgentRunner;
  /**
   * PreToolUse hook 通过 modifiedInput 修改工具参数前的原始参数快照。
   *
   * 典型场景：inject-env hook 在 Bash 命令前注入 `export FOO=bar;`，
   * toolArgs.command 变成 `"export FOO=bar; real_cmd"`，但原始的
   * `"real_cmd"` 保存在 originalInput.command 里。
   *
   * 工具可用此字段在 UI 展示（标题、终端头）中显示用户原始意图，
   * 同时仍用修改后的参数执行。
   */
  originalInput?: Record<string, unknown>;
}

/** 工具执行结果。 */
export interface ToolExecResult {
  /** 喂回给 LLM 作为 tool message body 的字符串。 */
  resultText: string;
  /** ACP `tool_call_update` 通知用的富内容。 */
  acpContent: ToolCallContent[];
  /** ACP tool_call 的 kind 区分符。 */
  kind: "read" | "edit" | "execute" | "other";
  /** 显示在客户端 UI 上的标题。 */
  title: string;
  /**
   * 本次调用涉及的文件位置；客户端据此提供 "Go to File" / 高亮跟随等功能
   * （Zed 在工具卡旁边渲染为可跳转链接）。
   */
  locations?: ToolCallLocation[];
  /** 是否成功；驱动 status 字段（completed / failed / cancelled）。 */
  ok: boolean;
  /** 是否被用户拒绝 —— 需要让 LLM 知道。 */
  denied?: boolean;
}

/**
 * 每个工具实现的契约。registry 收集所有工具，router 按 name 派发。
 */
export interface Tool {
  /** 工具名（PascalCase），唯一；作为 function.name 给 LLM。 */
  readonly name: string;
  /** 风险等级 —— router.ts 用来决定权限闸门 / 并发策略。 */
  readonly tier: RiskTier;
  /**
   * 可选：覆盖 tool_call.kind 的 UI 渲染等级。
   *
   * 默认值由 kindFromTier(tier) 推导（read→"read"、write→"edit"、execute→"execute"），
   * 但 tier 是**安全维度**而 kind 是**UI 渲染维度**，两者并不总是 1:1：
   *
   *   - SubAgent：tier="execute"（可触发任意子工具，受 writes/always 策略约束），
   *     但 UI 上是"思考型委派"。如果 kind="execute"，Zed 会按 terminal 风格渲染
   *     —— 卡片不带展开按钮、只显示一个 "Run Command" 头部。设 uiKind="other"
   *     让 Zed 用通用可展开卡，进度行 / 末态文本才能正常展示。
   *
   * 工具实现自行决定是否覆盖；prompt-loop 在初始 tool_call 通知中读取本字段。
   * tool.execute() 返回的 ToolExecResult.kind 也应与本字段一致，否则末态
   * tool_call_update 会"切换"卡片渲染模式，造成抖动。
   */
  readonly uiKind?: "read" | "edit" | "execute" | "other";
  /** 给 LLM 的 OpenAI 工具规范，function.name 必须和 name 一致。 */
  readonly spec: ToolSpec;
  /** 真正执行工具，产出可流回客户端的结果。 */
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecContext,
  ): Promise<ToolExecResult>;
}

/** 工具错误路径的统一构造器。 */
export function errorResult(
  msg: string,
  kind: "read" | "edit" | "execute" | "other",
  title: string,
): ToolExecResult {
  return {
    resultText: `ERROR: ${msg}`,
    acpContent: [
      { type: "content", content: { type: "text", text: `Error: ${msg}` } },
    ],
    kind,
    title,
    ok: false,
  };
}
