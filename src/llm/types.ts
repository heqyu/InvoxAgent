// LLMProvider — the abstraction that sits between InvoxAgent and any concrete
// LLM backend (OpenAI, Echo for tests, ollama, future Anthropic adapter, etc.).
//
// CHOICE: messages are kept in OpenAI shape (PLAN.md §1 decision log).
// The provider's contract: take messages + signal, yield text deltas.
// Tool-call deltas land in stage 3 — for stage 2 we only care about text.

export type Role = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: Role;
  content: string;
  // Stage 3 will add: tool_call_id, tool_calls. Kept narrow now.
}

/**
 * One delta from a streamed completion.
 *
 * Stage 2 emits only `text` deltas. Stage 3 will add `tool_call_start`,
 * `tool_call_arg_delta`, `tool_call_end`, `done` variants — at which point
 * this becomes a discriminated union.
 */
export interface LLMDelta {
  kind: "text";
  text: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  signal: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  stream(req: LLMRequest): AsyncIterable<LLMDelta>;
}
