// OpenAI 兼容 provider，支持 tool_call 流式拼装。
//
// 流式行为：
//   - text 内容增量 → yield { kind: "text" }
//   - tool_call 增量：按 index 累加每个调用的 id / name / arguments；
//     stream 结束后再按 index 顺序 emit 一次 `tool_call`，避免分片漏接
//   - 最后一个 chunk 含 usage 对象（要求开启 stream_options.include_usage）
//   - stream 结束 yield 一次 `finish`，附带 reason
//
// 日志策略：
//   info  —— 每个请求的开始 / 结束摘要（model + counts → 时延 + token）
//   debug —— chunk 级事件（首字节、长 gap）；带完整 HTTP 状态便于定位卡点
//   trace —— 完整请求 payload（messages + tools）和组装好的 tool calls。
//            **生产严禁开启** —— prompt / tool 输出可能含 API key、密钥等。

import OpenAI from "openai";
import { log } from "../log.js";
import {
  backoffConfigFromEnv,
  withConnectBackoff,
  type BackoffConfig,
} from "./backoff.js";
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
  /** 测试可注入的 backoff 覆盖；生产代码不传，从 env 读。 */
  backoff?: BackoffConfig;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;
  private baseURL: string;
  private backoff: BackoffConfig;
  /** 单调递增计数，给每次 LLM 调用分配一个短日志 id。 */
  private nextCallSeq = 1;

  constructor(cfg: OpenAIProviderConfig) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.baseURL = cfg.baseURL;
    this.backoff = cfg.backoff ?? backoffConfigFromEnv(process.env);
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const callId = `c${this.nextCallSeq++}`;
    const startedAt = Date.now();
    // 单次调用的 model 覆盖（来自 setSessionModel）；未设则用 provider 默认。
    const modelForCall = req.model ?? this.model;

    log.info("llm: request", {
      callId,
      model: modelForCall,
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
      // connect 阶段套指数退避（429 / 5xx / 网络）。
      // stream 一旦开始消费就不再重试 —— mid-stream 重放会破坏 ACP UI 的增量渲染。
      stream = await withConnectBackoff(
        () =>
          this.client.chat.completions.create(
            {
              model: modelForCall,
              stream: true,
              // 让上游在最末发一个 usage-only chunk，给我们真实 token 数。
              // 部分自托管 OAI-compat 后端会忽略这个 flag —— 没关系，我们就拿不到 usage delta。
              stream_options: { include_usage: true },
              messages: req.messages.map(toOpenAIMessage),
              ...(req.tools && req.tools.length > 0
                ? { tools: req.tools, tool_choice: "auto" }
                : {}),
              // 启用 thinking 时透传 reasoning_effort。OpenAI 文档枚举：
              // none | minimal | low | medium | high | xhigh。后端不识别该字段时
              // 通常忽略；严格的后端可能 400 —— 那是后端 vs 配置不匹配，
              // 用户可在下拉里换个值。
              ...(req.reasoningEffort && req.reasoningEffort !== "none"
                ? { reasoning_effort: req.reasoningEffort }
                : {}),
            },
            { signal: req.signal },
          ),
        this.backoff,
        {
          signal: req.signal,
          onRetry: (attempt, err, delayMs) => {
            log.warn("llm: retrying after retryable error", {
              callId,
              attempt,
              delayMs,
              ...describeError(err),
            });
          },
        },
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

    // tool_call 累加器：index → 部分调用
    const partials = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();
    let finishReason: FinishReason = "other";
    let textBytes = 0;
    let chunks = 0;
    let firstByteAt = 0;
    let lastChunkAt = startedAt;
    /**
     * `stream_options.include_usage` 产生的 usage-only 结尾 chunk。
     * OpenAI 规定 usage 字段仅在最后一个 chunk 上非空（且该 chunk 的 choices
     * 数组为空）。我们捕获之后在 stream 排干后 emit 一次 `kind: "usage"`。
     */
    let usageRaw: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    } | null = null;

    try {
      for await (const chunk of stream) {
        chunks += 1;
        const now = Date.now();
        if (firstByteAt === 0) {
          firstByteAt = now;
        }
        // 卡顿启发：chunk 间隔 > 5s 不正常，记一条 debug 便于定位。
        if (now - lastChunkAt > 5000) {
          log.debug("llm: chunk gap", {
            callId,
            gapMs: now - lastChunkAt,
            chunks,
          });
        }
        lastChunkAt = now;

        // 在 `!choice` 兜底之前先抓 usage —— usage-only chunk 的 choices 是空，
        // 否则会被那个守卫吃掉。
        if (chunk.usage) {
          usageRaw = chunk.usage;
        }

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

    const usage = usageRaw
      ? {
          input: usageRaw.prompt_tokens ?? 0,
          output: usageRaw.completion_tokens ?? 0,
          total:
            usageRaw.total_tokens ??
            (usageRaw.prompt_tokens ?? 0) + (usageRaw.completion_tokens ?? 0),
          cached: usageRaw.prompt_tokens_details?.cached_tokens ?? 0,
        }
      : null;

    // 总是把 provider 原始 usage 写进日志 —— 方便对照 OpenAI 计费 dashboard，
    // 验证 invox 显示的数字是否准确。
    log.info("llm: response", {
      callId,
      elapsedMs: Date.now() - startedAt,
      ttfbMs: firstByteAt ? firstByteAt - startedAt : -1,
      chunks,
      textBytes,
      toolCalls: partials.size,
      finishReason,
      // 原始用量（prompt_tokens / completion_tokens / total_tokens）—— 与上游账单核对用
      rawUsage: usageRaw ?? "(provider did not return usage)",
      // 映射后内部用量（进入 turnUsage 的部分）
      ...(usage ? { usage } : {}),
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

    // 按 index 顺序 emit 组装好的 tool_call
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

    if (usage) {
      yield { kind: "usage", usage };
    }

    yield { kind: "finish", reason: finishReason };
  }
}

/**
 * 把内部 LLMMessage 转成 OpenAI ChatCompletionMessageParam。
 * - system / assistant / tool：content 恒为 string，原样传
 * - user：content 可能是 string 或 ChatCompletionContentPart[]（image_url），
 *   也是原样透传（已是 OpenAI 形状）
 */
function toOpenAIMessage(
  m: LLMMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content as string };
    case "user":
      // m.content = string | ChatCompletionContentPart[]
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
 * 从 OpenAI / fetch 错误里抽出最有用的诊断字段。SDK 的 APIError 带 status 和
 * error（上游返回的 JSON body）。**绝不**把 URL / headers 写进来 —— apiKey 会泄漏。
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
