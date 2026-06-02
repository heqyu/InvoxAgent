// LLMProvider — the abstraction between InvoxAgent and any LLM backend.
//
// Stage 3 extension: the delta union now carries tool_call events.
// Provider behavior:
//   - text deltas: emitted as soon as visible tokens arrive
//   - tool_call deltas: emitted once per fully-assembled tool call (after the
//     model has finished streaming arguments — accumulating per-index args
//     to dodge the PLAN §3 pitfall)
//   - finish delta: emitted exactly once, signaling stream end + reason
//
import type OpenAI from "openai";

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * User message content.
 * - string: plain text (most common)
 * - ChatCompletionContentPart[]: multi-modal (text + image_url)
 *
 * This is exactly OpenAI's type — no custom wrappers, no converters.
 */
export type UserContent =
  | string
  | OpenAI.Chat.Completions.ChatCompletionContentPart[];

export interface LLMMessage {
  role: Role;
  /** system/assistant/tool: always string. user: string or content-part array. */
  content: string | UserContent;
  tool_call_id?: string;
  tool_calls?: ParsedToolCall[];
  name?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LLMDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ParsedToolCall }
  | { kind: "usage"; usage: UsageInfo }
  | { kind: "finish"; reason: FinishReason };

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

/**
 * Token accounting for one LLM call. Sourced from the upstream provider's
 * usage block (OpenAI-compat: prompt_tokens / completion_tokens / total_tokens).
 *
 * Numbers are best-effort: if the provider does not return usage for the call
 * (some self-hosted OAI-compat backends ignore `stream_options.include_usage`),
 * the provider may simply not yield a `usage` delta — agents should treat
 * this as "unknown" rather than zero.
 */
export interface UsageInfo {
  /** Tokens consumed by the prompt (input). */
  input: number;
  /** Tokens emitted by the completion (output). */
  output: number;
  /** input + output as reported by the provider; may differ from the sum if
   *  the provider counts cache/system overhead separately. */
  total: number;
  /** Tokens served from prompt cache (prefix caching). 0 when the provider
   *  does not report this detail. */
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
   * Per-call model override. When unset, the provider falls back to its
   * constructor-time default. Used by InvoxAgent to honor `setSessionModel`
   * without rebuilding the provider instance.
   */
  model?: string;
  /**
   * Reasoning / "thinking" effort for the upstream model. Maps directly
   * onto OpenAI's `reasoning_effort` field on chat.completions; non-OpenAI
   * backends usually ignore it. `none` is treated the same as undefined
   * (field omitted from the wire request); `minimal/low/medium/high` are
   * passed through verbatim.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "none";
}

export interface LLMProvider {
  readonly name: string;
  stream(req: LLMRequest): AsyncIterable<LLMDelta>;
}
