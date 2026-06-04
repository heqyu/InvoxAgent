// 指数退避（仅 connect 阶段）—— B3 / Phase B 验收。
//
// 仅在「stream 还没开始」之前重试，因为：
//   - mid-stream 重放会破坏 ACP UI 的增量渲染（用户已经看到字符冒出来，
//     回卷到第 0 帧再来一遍是糟糕体验）
//   - tool_call 部分流出时重放会触发重复执行，违反幂等假设
//
// 可重试场景：
//   - HTTP 429（rate limit）
//   - HTTP 5xx（server）
//   - 常见网络错误码（ECONNRESET / ETIMEDOUT / ECONNREFUSED / ENOTFOUND /
//     EAI_AGAIN / UND_ERR_*）
//
// 不可重试 / 跳过：
//   - 4xx 非 429（请求本身有问题，重试无意义）
//   - AbortError（用户取消，立刻冒泡）
//   - 任何未知形态错误
//
// env 调参：
//   INVOX_LLM_RETRIES        默认 3，设为 0 完全关闭
//   INVOX_LLM_BACKOFF_BASE_MS 默认 500
//   INVOX_LLM_BACKOFF_MAX_MS  默认 8000

export interface BackoffConfig {
  /** 最多重试次数（不含首次），0 = 关闭重试。 */
  maxRetries: number;
  /** 第一次退避基数毫秒（指数底）。 */
  baseMs: number;
  /** 单次退避上限毫秒。 */
  maxMs: number;
  /** 抖动比率 0..1：实际延迟在 [delay*(1-jitter), delay*(1+jitter)] 内随机。 */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  maxRetries: 3,
  baseMs: 500,
  maxMs: 8000,
  jitter: 0.3,
};

/**
 * 从 process.env 读取 backoff 配置。非法值（NaN / 负数）回退到默认。
 */
export function backoffConfigFromEnv(env: NodeJS.ProcessEnv): BackoffConfig {
  return {
    maxRetries: parsePositiveInt(env["INVOX_LLM_RETRIES"], DEFAULT_BACKOFF.maxRetries),
    baseMs: parsePositiveInt(
      env["INVOX_LLM_BACKOFF_BASE_MS"],
      DEFAULT_BACKOFF.baseMs,
    ),
    maxMs: parsePositiveInt(
      env["INVOX_LLM_BACKOFF_MAX_MS"],
      DEFAULT_BACKOFF.maxMs,
    ),
    jitter: DEFAULT_BACKOFF.jitter,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * 判断一个 connect 阶段错误是否值得重试。null / 标量 / 普通 Error 都返回
 * false —— 我们只在确定可恢复的场景才掏退避成本。
 */
export function isRetryableConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown };

  // AbortError 不重试
  if (typeof e.name === "string" && e.name === "AbortError") return false;

  // 4xx / 5xx 通过 status 判定
  if (typeof e.status === "number") {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    return false;
  }

  // 网络层错误码
  if (typeof e.code === "string") {
    return RETRYABLE_NET_CODES.has(e.code);
  }

  return false;
}

const RETRYABLE_NET_CODES = new Set<string>([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  // undici (Node 内置 fetch) 错误码
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 计算第 attempt 次（从 0 开始）的退避延迟。
 * 公式：min(base * 2^attempt, max) ± jitter*delay 的均匀抖动。
 */
export function backoffDelayMs(
  attempt: number,
  cfg: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exp = cfg.baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, cfg.maxMs);
  const jitterRange = capped * cfg.jitter;
  // (random()*2 - 1) ∈ [-1, 1] → 偏移 [-jitterRange, +jitterRange]
  const offset = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + offset));
}

export interface RetryHooks {
  /** abort 信号：触发后下一轮 sleep 立刻 reject AbortError。 */
  signal?: AbortSignal;
  /** 每次重试前回调，便于上层 log。attempt 是即将进行的第几次重试（1-based）。 */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** 测试可注入的 sleep（默认 setTimeout）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 测试可注入的随机源。 */
  random?: () => number;
}

/**
 * 用 backoff 策略包裹一个 connect-like 的 task。task 必须幂等（典型场景：
 * 打开 streaming 连接但还没消费 chunk）。
 *
 * - signal 在 task 调用之间检查；task 自身需要尊重 AbortSignal 通过参数传入
 * - onRetry 回调在每次「决定重试 + 已计算延迟 + 还没 sleep」时触发
 * - 重试不可恢复错误立刻冒泡；用尽 maxRetries 后冒泡最后一次错误
 */
export async function withConnectBackoff<T>(
  task: () => Promise<T>,
  cfg: BackoffConfig,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    if (hooks.signal?.aborted) throw makeAbortError();
    try {
      return await task();
    } catch (err) {
      if (attempt >= cfg.maxRetries) throw err;
      if (!isRetryableConnectError(err)) throw err;
      const delayMs = backoffDelayMs(attempt, cfg, hooks.random);
      hooks.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs, hooks.signal);
      attempt += 1;
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(makeAbortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
