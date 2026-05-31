// OpenAI-compatible provider. Uses the official `openai` SDK with baseURL
// override → works against any OpenAI-API-compatible endpoint (OpenAI itself,
// DeepSeek, Together, vLLM, Ollama's openai-shim, LM Studio, etc.).
//
// CHOICE: official SDK over hand-rolled fetch. Reasons:
//   - typed streaming + tool_calls (stage 3 will lean on the latter)
//   - first-class AbortSignal support (cancellation, PLAN §3 pitfall)
//   - automatic SSE parsing
//
// PITFALL guard (PLAN §3): we skip empty content deltas to avoid spamming
// the client with no-op `agent_message_chunk` notifications. In stage 3,
// tool_call-only chunks will arrive with empty .content but populated
// .tool_calls — handled there.

import OpenAI from "openai";
import { log } from "../log.js";
import type { LLMDelta, LLMProvider, LLMRequest } from "./types.js";

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
    log.debug("openai stream start", { model: this.model, msgs: req.messages.length });

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      },
      { signal: req.signal },
    );

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        const text = delta?.content;
        if (typeof text === "string" && text.length > 0) {
          yield { kind: "text", text };
        }
        // Stage 3: handle delta.tool_calls here.
      }
    } finally {
      // Best-effort: SDK auto-closes on abort, this is just defensive.
      log.debug("openai stream end");
    }
  }
}
