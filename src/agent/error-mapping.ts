// LLM provider 错误 → ACP `stopReason` 映射 —— Phase A5 / K9
//
// 设计点：
//   - prompt() 必须始终返回合法 PromptResponse，绝不向 ACP RPC 抛异常 ——
//     否则客户端看到的是裸 RPC error，没有 stopReason，UI 不知道发生了什么
//   - OpenAI SDK 的 APIError 暴露 `status` 数字，按 HTTP 语义分桶
//   - 网络错误（ECONNRESET / ENOTFOUND / ETIMEDOUT）直接走 refusal
//   - AbortError 单独识别 —— 它是 cancellation 不是失败
//
// ACP 协议规定的 stopReason 字面量（见 PLAN §4 / sdk schema）：
//   "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
//
// 我们仅在 error 路径产出 "refusal" 或 "cancelled"；正常完成 / 超迭代分别由
// "end_turn" / "max_turn_requests" 在调用方决定。

/**
 * Provider 错误的可读元数据 —— 既用于日志，也用于回流给 LLM / 用户的
 * agent_message_chunk 文本。
 */
export interface ProviderErrorInfo {
  /** 短分类：rate_limit / auth / server / network / unknown，便于客户端做 UI */
  category:
    | "rate_limit"
    | "auth"
    | "server"
    | "network"
    | "bad_request"
    | "unknown";
  /** 一句话描述（可直接展示给用户） */
  message: string;
  /** HTTP status（若有） */
  status?: number;
  /** Node 错误 code（如 ECONNRESET），若有 */
  code?: string;
}

/** classifyProviderError 的返回 —— discriminated union 让调用方按 kind 分流。 */
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
  // 1. AbortError —— 用户主动取消，这是合法状态，不算失败
  if (isAbortError(err)) return { kind: "abort" };

  // null / undefined / 标量值：直接走 unknown 桶，避免后续解构抛错
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

  // 2. HTTP 状态分桶（OpenAI SDK 的 APIError）
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
        message: `LLM provider auth failed (HTTP ${status}). Check INVOX_API_KEY.`,
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

  // 3. Node 网络错误码
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return refusal({
      category: "network",
      message: `Network error talking to LLM provider (${code}). ${shortenMessage(message)}`,
      ...(status !== undefined ? { status } : {}),
      code,
    });
  }

  // 4. fetch 风格的"TypeError: fetch failed"也归网络
  if (/fetch failed|network|ECONN/i.test(message)) {
    return refusal({
      category: "network",
      message: `Network error talking to LLM provider. ${shortenMessage(message)}`,
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }

  // 5. 兜底
  return refusal({
    category: "unknown",
    message: `LLM provider error: ${shortenMessage(message)}`,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  });
}

/**
 * 把 ProviderErrorInfo 渲染成给最终用户的友好文本（会塞进
 * agent_message_chunk）。短小，一行能读完。
 */
export function formatProviderErrorForUser(info: ProviderErrorInfo): string {
  return `⚠️ ${info.message}`;
}

// ── 内部 ─────────────────────────────────────────────────────────────

/** Node 已知的网络层错误码 */
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
