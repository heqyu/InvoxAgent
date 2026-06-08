// LLMProvider 抽象 —— InvoxAgent 与任意 LLM 后端之间的契约。
//
// stream() 的产出语义：
//   - text   —— 收到可见 token 时立即吐
//   - tool_call —— 一个完整组装好的工具调用（在 provider 内部按 index 累加
//                  完整参数后才 emit，避免分片漏掉）
//   - usage  —— 整个流的用量统计，通常来自 stream_options.include_usage
//   - finish —— 全流结束时恰好 emit 一次

import type OpenAI from "openai";

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * user 消息内容：
 * - string：纯文本（最常见）
 * - ChatCompletionContentPart[]：多模态（text + image_url）
 *
 * 直接复用 OpenAI 类型，不做自定义封装。
 */
export type UserContent =
  | string
  | OpenAI.Chat.Completions.ChatCompletionContentPart[];

export interface LLMMessage {
  role: Role;
  /** system / assistant / tool：恒为 string；user：string 或 content-part 数组。 */
  content: string | UserContent;
  tool_call_id?: string;
  tool_calls?: ParsedToolCall[];
  name?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
  /** 工具执行结果：成功 or 失败。执行后由 prompt-loop 回填。 */
  ok?: boolean;
  /** 工具执行耗时（毫秒）。执行后由 prompt-loop 回填。 */
  elapsedMs?: number;
}

export type LLMDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ParsedToolCall }
  | { kind: "usage"; usage: UsageInfo }
  | { kind: "finish"; reason: FinishReason };

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

/**
 * 单次 LLM 调用的 token 用量。源自上游 provider 的 usage 块（OpenAI 兼容：
 * prompt_tokens / completion_tokens / total_tokens）。
 *
 * 是 best-effort 数据：部分自托管后端忽略 stream_options.include_usage，
 * provider 可能完全不 yield usage delta，agent 应当当作"未知"而不是 0。
 */
export interface UsageInfo {
  /** prompt（输入）消耗的 tokens。 */
  input: number;
  /** completion（输出）消耗的 tokens。 */
  output: number;
  /** provider 上报的 input + output；可能与简单相加略有差异（cache / system 计费）。 */
  total: number;
  /** 命中 prompt prefix cache 的 tokens；provider 不报时为 0。 */
  cached: number;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface LLMRequest {
  messages: LLMMessage[];
  signal: AbortSignal;
  tools?: ToolSpec[];
  /**
   * 单次调用的 model 覆盖。未设置时 provider 走构造时的默认值。
   * InvoxAgent 用这个支持 setSessionModel —— 不需要重建 provider 实例。
   */
  model?: string;
  /**
   * 上游模型的 reasoning / "thinking" 强度，对应 OpenAI chat.completions
   * 的 `reasoning_effort` 字段；非 OpenAI 后端通常忽略它。
   * `none` 等同于未设置（字段不进 wire 请求）。
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "none";
}

export interface LLMProvider {
  readonly name: string;
  stream(req: LLMRequest): AsyncIterable<LLMDelta>;
}
