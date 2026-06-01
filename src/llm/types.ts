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
  | { kind: "finish"; reason: FinishReason };

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

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
}

export interface LLMProvider {
  readonly name: string;
  stream(req: LLMRequest): AsyncIterable<LLMDelta>;
}
