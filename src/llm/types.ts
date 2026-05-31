// LLMProvider — the abstraction between InvoxAgent and any LLM backend.
//
// Stage 3 extension: the delta union now carries tool_call events.
// Provider behavior:
//   - text deltas: emitted as soon as visible tokens arrive
//   - tool_call deltas: emitted once per fully-assembled tool call (after the
//     model has finished streaming arguments — accumulating per-index args
//     to dodge the PLAN §3 pitfall)
//   - finish delta: emitted exactly once, signaling stream end + reason

export type Role = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: Role;
  content: string;
  // Stage 3 additions:
  tool_call_id?: string; // present on role:"tool"
  tool_calls?: ParsedToolCall[]; // present on role:"assistant" if it requested tools
  name?: string; // optional, for role:"tool"
}

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model. Parsed by the tool router. */
  arguments: string;
}

export type LLMDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ParsedToolCall }
  | { kind: "finish"; reason: FinishReason };

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

/** OpenAI function-tool spec, as accepted by chat.completions.create({ tools }) */
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
