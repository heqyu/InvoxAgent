// OpenAI-compatible provider with tool_call support (stage 3).
//
// Streaming behavior:
//   - text content deltas → yield { kind: "text" }
//   - tool_call deltas: accumulate per-index id/name/arguments. When stream
//     ends, yield one { kind: "tool_call", call } per assembled tool call.
//     This dodges PLAN §3 pitfall ("LLM tool_call streaming arg deltas:
//     naive concat misses indices") by tracking a per-index buffer.
//   - on stream end, yield { kind: "finish", reason }.

import OpenAI from "openai";
import { log } from "../log.js";
import type {
  FinishReason,
  LLMDelta,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  ParsedToolCall,
} from "./types.js";

export interface OpenAIProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(cfg: OpenAIProviderConfig) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    log.debug("openai stream start", {
      model: this.model,
      msgs: req.messages.length,
      tools: req.tools?.length ?? 0,
    });

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        messages: req.messages.map(toOpenAIMessage),
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools, tool_choice: "auto" } : {}),
      },
      { signal: req.signal },
    );

    // tool_call accumulator: index → partial call
    const partials = new Map<number, { id: string; name: string; argsBuf: string }>();
    let finishReason: FinishReason = "other";

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        // Text delta
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          yield { kind: "text", text: delta.content };
        }

        // Tool_call deltas: per-index accumulation
        if (delta?.tool_calls) {
          for (const tcd of delta.tool_calls) {
            const idx = tcd.index;
            let p = partials.get(idx);
            if (!p) {
              p = { id: "", name: "", argsBuf: "" };
              partials.set(idx, p);
            }
            if (tcd.id) p.id = tcd.id;
            if (tcd.function?.name) p.name = tcd.function.name;
            if (tcd.function?.arguments) p.argsBuf += tcd.function.arguments;
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    } finally {
      log.debug("openai stream end", { finishReason, toolCalls: partials.size });
    }

    // Emit assembled tool_calls in index order.
    const indices = [...partials.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const p = partials.get(idx);
      if (!p) continue;
      const call: ParsedToolCall = { id: p.id, name: p.name, arguments: p.argsBuf };
      yield { kind: "tool_call", call };
    }

    yield { kind: "finish", reason: finishReason };
  }
}

function toOpenAIMessage(m: LLMMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.tool_calls && m.tool_calls.length > 0
          ? {
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      if (!m.tool_call_id) throw new Error("tool message missing tool_call_id");
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content,
      };
  }
}

function mapFinishReason(r: string): "stop" | "tool_calls" | "length" | "other" {
  if (r === "stop") return "stop";
  if (r === "tool_calls" || r === "function_call") return "tool_calls";
  if (r === "length") return "length";
  return "other";
}
