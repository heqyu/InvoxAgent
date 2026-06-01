// OpenAI-compatible provider with tool_call support.
//
// Streaming behavior:
//   - text content deltas → yield { kind: "text" }
//   - tool_call deltas: accumulate per-index id/name/arguments. When stream
//     ends, yield one { kind: "tool_call", call } per assembled tool call.
//     This dodges PLAN §3 pitfall ("LLM tool_call streaming arg deltas:
//     naive concat misses indices") by tracking a per-index buffer.
//   - on stream end, yield { kind: "finish", reason }.
//
// Logging discipline:
//   info  — one line per request boundary (start with model+counts, end with
//           timing+token-bytes-totals). Default level so users see "is the
//           LLM call alive?".
//   debug — chunk-level events: first byte received, every Nth chunk, errors
//           with full HTTP status. Useful to localize "where it stalled".
//   trace — full request payload (messages + tools) and full response.
//           NEVER set this in production (leaks secrets if your prompts
//           include API keys, tokens, etc.).
//
import OpenAI from "openai";
import { log } from "../log.js";
import type {
  FinishReason,
  LLMDelta,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  ParsedToolCall,
  UserContent,
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
  private baseURL: string;
  /** Monotonic counter so each LLM call has a short id in logs. */
  private nextCallSeq = 1;

  constructor(cfg: OpenAIProviderConfig) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.baseURL = cfg.baseURL;
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const callId = `c${this.nextCallSeq++}`;
    const startedAt = Date.now();

    log.info("llm: request", {
      callId,
      model: this.model,
      baseURL: this.baseURL,
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
    });

    if (log.isEnabled("trace")) {
      log.trace("llm: request payload", {
        callId,
        messages: req.messages,
        tools: req.tools,
      });
    }

    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          stream: true,
          messages: req.messages.map(toOpenAIMessage),
          ...(req.tools && req.tools.length > 0
            ? { tools: req.tools, tool_choice: "auto" }
            : {}),
        },
        { signal: req.signal },
      );
    } catch (err) {
      const detail = describeError(err);
      log.error("llm: request failed before streaming", {
        callId,
        elapsedMs: Date.now() - startedAt,
        ...detail,
      });
      throw err;
    }

    log.debug("llm: stream opened", {
      callId,
      elapsedMs: Date.now() - startedAt,
    });

    // tool_call accumulator: index → partial call
    const partials = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();
    let finishReason: FinishReason = "other";
    let textBytes = 0;
    let chunks = 0;
    let firstByteAt = 0;
    let lastChunkAt = startedAt;

    try {
      for await (const chunk of stream) {
        chunks += 1;
        const now = Date.now();
        if (firstByteAt === 0) {
          firstByteAt = now;
          log.debug("llm: first chunk", {
            callId,
            ttfbMs: now - startedAt,
          });
        }
        // Stall heuristic: gap > 5s between chunks is unusual for chat
        // completions and worth surfacing.
        if (now - lastChunkAt > 5000) {
          log.debug("llm: chunk gap", {
            callId,
            gapMs: now - lastChunkAt,
            chunks,
          });
        }
        lastChunkAt = now;

        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (typeof delta?.content === "string" && delta.content.length > 0) {
          textBytes += delta.content.length;
          yield { kind: "text", text: delta.content };
        }

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
    } catch (err) {
      const detail = describeError(err);
      log.error("llm: stream errored", {
        callId,
        elapsedMs: Date.now() - startedAt,
        chunks,
        textBytes,
        ...detail,
      });
      throw err;
    }

    log.info("llm: response", {
      callId,
      elapsedMs: Date.now() - startedAt,
      ttfbMs: firstByteAt ? firstByteAt - startedAt : -1,
      chunks,
      textBytes,
      toolCalls: partials.size,
      finishReason,
    });

    if (log.isEnabled("trace") && partials.size > 0) {
      log.trace("llm: tool calls assembled", {
        callId,
        calls: [...partials.entries()].map(([idx, p]) => ({
          idx,
          id: p.id,
          name: p.name,
          arguments: p.argsBuf,
        })),
      });
    }

    // Emit assembled tool_calls in index order.
    const indices = [...partials.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const p = partials.get(idx);
      if (!p) continue;
      const call: ParsedToolCall = {
        id: p.id,
        name: p.name,
        arguments: p.argsBuf,
      };
      yield { kind: "tool_call", call };
    }

    yield { kind: "finish", reason: finishReason };
  }
}

/**
 * Convert internal LLMMessage → OpenAI ChatCompletionMessageParam.
 *
 * - system/assistant/tool: content is always string. Pass directly.
 * - user: content may be string or ChatCompletionContentPart[] (image_url).
 *   Pass through as-is — it's already in OpenAI format.
 */
function toOpenAIMessage(
  m: LLMMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content as string };
    case "user":
      // m.content is UserContent = string | ChatCompletionContentPart[]
      return { role: "user", content: m.content as UserContent };
    case "assistant":
      return {
        role: "assistant",
        content: m.content as string,
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
        content: m.content as string,
      };
  }
}

function mapFinishReason(
  r: string,
): "stop" | "tool_calls" | "length" | "other" {
  if (r === "stop") return "stop";
  if (r === "tool_calls" || r === "function_call") return "tool_calls";
  if (r === "length") return "length";
  return "other";
}

/**
 * Pull the most useful diagnostic fields out of an OpenAI / fetch error.
 * APIError from the SDK has `status` and `error` (the JSON body the upstream
 * sent back). We never include the request URL/headers (apiKey could leak).
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      name?: string;
      status?: number;
      code?: string;
      error?: unknown;
    };
    return {
      name: e.name,
      message: e.message,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.code !== undefined ? { code: e.code } : {}),
      ...(e.error !== undefined ? { upstreamError: e.error } : {}),
    };
  }
  return { message: String(err) };
}
