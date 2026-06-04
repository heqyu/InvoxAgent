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
  /** 风险等级 —— router.ts 用来决定权限闸门。 */
  readonly tier: RiskTier;
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
