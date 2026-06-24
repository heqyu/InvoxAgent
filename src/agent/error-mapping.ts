// LLM provider 错误 → ACP `stopReason` 映射。
//
// 设计点：
//   - prompt() 必须始终返回合法 PromptResponse，绝不向 ACP RPC 抛异常 ——
//     否则客户端只能看到裸 RPC error，没有 stopReason，UI 不知道发生了什么
//   - OpenAI SDK 的 APIError 暴露 status，按 HTTP 语义分桶
//   - 网络错误（ECONNRESET / ENOTFOUND / ETIMEDOUT 等）直接走 refusal
//   - AbortError 单独识别 —— 它是 cancellation 不是失败
//
// 协议规定的 stopReason 字面量：
//   "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
// 我们仅在错误路径产出 "refusal" / "cancelled"；
// "end_turn" / "max_turn_requests" 由调用方在正常流程上决定。

/** Provider 错误的可读元信息：日志 + 回流给用户的 agent_message_chunk 共用。 */
export interface ProviderErrorInfo {
  /** 短分类 —— 便于客户端做 UI 区分。 */
  category:
    | "rate_limit"
    | "auth"
    | "server"
    | "network"
    | "bad_request"
    | "context_limit"
    | "unknown";
  /** 一句话描述，可直接展示给用户。 */
  message: string;
  /** HTTP status（若有）。 */
  status?: number;
  /** Node 错误码（如 ECONNRESET，若有）。 */
  code?: string;
}

/** classifyProviderError 的 discriminated union 返回。 */
export type ClassifiedError =
  | { kind: "abort" }
  | { kind: "refusal"; info: ProviderErrorInfo };

/**
 * 把任意 provider 抛出的错误归类为 ACP-friendly 的 stopReason 决策。
 *
 * caller 行为：
 *   - { kind: "abort" }    → stopReason: "cancelled"
 *   - { kind: "refusal" }  → stopReason: "refusal"，并把 info.message
 *                            通过 agent_message_chunk 告诉用户
 */
export function classifyProviderError(err: unknown): ClassifiedError {
  // 1. AbortError —— 用户主动取消，合法状态，不算失败
  if (isAbortError(err)) return { kind: "abort" };

  // null / undefined / 标量：归 unknown 桶，避免后续解构抛错
  if (err === null || err === undefined || typeof err !== "object") {
    return refusal({
      category: "unknown",
      message: `LLM provider error: ${shortenMessage(String(err))}`,
    });
  }

  const e = err as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const message = typeof e.message === "string" ? e.message : String(err);
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;

  // 2. Context limit detection (before HTTP status check — many providers
  //    return 400 for context limit errors, but the message is more specific).
  if (CONTEXT_LIMIT_PATTERNS.some((p) => p.test(message))) {
    return refusal({
      category: "context_limit",
      message: `上下文超出模型上限。请新建会话或精简 prompt。${shortenMessage(message)}`,
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }

  // 3. HTTP 状态分桶（OpenAI SDK 的 APIError）
  if (status !== undefined) {
    if (status === 429) {
      return refusal({
        category: "rate_limit",
        message: `LLM provider rate-limited (HTTP 429). ${shortenMessage(message)}`,
        status,
        ...(code !== undefined ? { code } : {}),
      });
    }
    if (status === 401 || status === 403) {
      return refusal({
        category: "auth",
        message: `LLM provider auth failed (HTTP ${status}). Check your API key in providers.json.`,
        status,
        ...(code !== undefined ? { code } : {}),
      });
    }
    if (status >= 500) {
      return refusal({
        category: "server",
        message: `LLM provider server error (HTTP ${status}). ${shortenMessage(message)}`,
        status,
        ...(code !== undefined ? { code } : {}),
      });
    }
    if (status >= 400) {
      return refusal({
        category: "bad_request",
        message: `LLM provider rejected request (HTTP ${status}). ${shortenMessage(message)}`,
        status,
        ...(code !== undefined ? { code } : {}),
      });
    }
  }

  // 4. Node 网络错误码
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return refusal({
      category: "network",
      message: `Network error talking to LLM provider (${code}). ${shortenMessage(message)}`,
      ...(status !== undefined ? { status } : {}),
      code,
    });
  }

  // 5. fetch 风格的 "TypeError: fetch failed" 也归网络
  if (/fetch failed|network|ECONN/i.test(message)) {
    return refusal({
      category: "network",
      message: `Network error talking to LLM provider. ${shortenMessage(message)}`,
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }

  // 6. 兜底
  return refusal({
    category: "unknown",
    message: `LLM provider error: ${shortenMessage(message)}`,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  });
}

/** 把 ProviderErrorInfo 渲染成给用户看的友好文本（塞进 agent_message_chunk）。 */
export function formatProviderErrorForUser(info: ProviderErrorInfo): string {
  return `⚠️ ${info.message}`;
}

/**
 * 把 ProviderErrorInfo 序列化成可塞入 ACP `_meta["invox/error"]` 的对象。
 *
 * 设计点：
 *   - 仅输出协议官方 `_meta` 文档允许的"附加元数据"；客户端不识别该 key
 *     时应当原样忽略
 *   - 不把 stack trace / SDK 内部字段塞进来 —— 那是日志的事
 *   - 字段顺序固定（category / message / status / code）方便客户端断言
 *   - JSON.stringify 友好：字段都是 string | number | undefined
 */
export function serializeRefusalForMeta(
  info: ProviderErrorInfo,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    category: info.category,
    message: info.message,
  };
  if (typeof info.status === "number") out.status = info.status;
  if (typeof info.code === "string") out.code = info.code;
  return out;
}

// ── 内部 ─────────────────────────────────────────────────────────────

/** Context limit 正则模式 —— 匹配 OpenAI / Anthropic / 其它 provider 的上下文超限错误。 */
const CONTEXT_LIMIT_PATTERNS = [
  /maximum context length is \d+ tokens/i,
  /context.*length.*exceeded/i,
  /tokens.*exceeds.*model.*max/i,
];

/** Node 已知的网络层错误码。 */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

function refusal(info: ProviderErrorInfo): ClassifiedError {
  return { kind: "refusal", info };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  if (typeof e.message === "string" && /aborted/i.test(e.message)) return true;
  return false;
}

function shortenMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? oneLine.slice(0, 200) + "…" : oneLine;
}
