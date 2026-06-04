// LLM connect-阶段退避策略单测 —— B3 / Phase B 验收。

import { describe, expect, it, vi } from "vitest";
import {
  backoffConfigFromEnv,
  backoffDelayMs,
  DEFAULT_BACKOFF,
  isRetryableConnectError,
  withConnectBackoff,
} from "../../src/llm/backoff.js";

describe("backoff: isRetryableConnectError", () => {
  it("HTTP 429 → 可重试", () => {
    expect(isRetryableConnectError({ status: 429 })).toBe(true);
  });

  it("HTTP 5xx → 可重试（500/502/503/504/599 边界）", () => {
    expect(isRetryableConnectError({ status: 500 })).toBe(true);
    expect(isRetryableConnectError({ status: 502 })).toBe(true);
    expect(isRetryableConnectError({ status: 503 })).toBe(true);
    expect(isRetryableConnectError({ status: 504 })).toBe(true);
    expect(isRetryableConnectError({ status: 599 })).toBe(true);
  });

  it("HTTP 4xx 非 429 → 不重试", () => {
    expect(isRetryableConnectError({ status: 400 })).toBe(false);
    expect(isRetryableConnectError({ status: 401 })).toBe(false);
    expect(isRetryableConnectError({ status: 403 })).toBe(false);
    expect(isRetryableConnectError({ status: 404 })).toBe(false);
    expect(isRetryableConnectError({ status: 422 })).toBe(false);
  });

  it("HTTP 600 / 200 / 300 → 不重试（不在 5xx 范围）", () => {
    expect(isRetryableConnectError({ status: 200 })).toBe(false);
    expect(isRetryableConnectError({ status: 301 })).toBe(false);
    expect(isRetryableConnectError({ status: 600 })).toBe(false);
  });

  it("常见网络错误码 → 可重试", () => {
    for (const code of [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ]) {
      expect(isRetryableConnectError({ code }), code).toBe(true);
    }
  });

  it("AbortError → 不重试（即使 status 为 5xx）", () => {
    expect(isRetryableConnectError({ name: "AbortError" })).toBe(false);
    expect(
      isRetryableConnectError({ name: "AbortError", status: 503 }),
    ).toBe(false);
  });

  it("null / undefined / 标量 / Symbol → 不重试", () => {
    expect(isRetryableConnectError(null)).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
    expect(isRetryableConnectError("ECONNRESET")).toBe(false);
    expect(isRetryableConnectError(429)).toBe(false);
    expect(isRetryableConnectError(Symbol("x"))).toBe(false);
  });

  it("普通 Error 对象（无 status / 无 code）→ 不重试", () => {
    expect(isRetryableConnectError(new Error("oops"))).toBe(false);
  });

  it("未知 code → 不重试", () => {
    expect(isRetryableConnectError({ code: "ENONSENSE" })).toBe(false);
  });
});

describe("backoff: backoffDelayMs", () => {
  it("无抖动时按 base * 2^attempt 增长，封顶在 maxMs", () => {
    const cfg = { maxRetries: 5, baseMs: 100, maxMs: 1600, jitter: 0 };
    const random = (): number => 0.5; // 偏移 = 0
    expect(backoffDelayMs(0, cfg, random)).toBe(100);
    expect(backoffDelayMs(1, cfg, random)).toBe(200);
    expect(backoffDelayMs(2, cfg, random)).toBe(400);
    expect(backoffDelayMs(3, cfg, random)).toBe(800);
    expect(backoffDelayMs(4, cfg, random)).toBe(1600);
    expect(backoffDelayMs(5, cfg, random)).toBe(1600); // 封顶
    expect(backoffDelayMs(10, cfg, random)).toBe(1600);
  });

  it("jitter=0.3 时延迟在 [delay*0.7, delay*1.3] 范围", () => {
    const cfg = { maxRetries: 5, baseMs: 1000, maxMs: 10_000, jitter: 0.3 };
    // random=0 → offset = -1*1000*0.3 = -300，延迟 = 700
    expect(backoffDelayMs(0, cfg, () => 0)).toBe(700);
    // random=1 → offset = +1*1000*0.3 = +300，延迟 = 1300
    expect(backoffDelayMs(0, cfg, () => 1)).toBe(1300);
    // random=0.5 → offset = 0，延迟 = 1000
    expect(backoffDelayMs(0, cfg, () => 0.5)).toBe(1000);
  });

  it("延迟下限是 0（不会返回负数）", () => {
    const cfg = { maxRetries: 5, baseMs: 100, maxMs: 1000, jitter: 5 };
    // jitter=5 + random=0 → offset = -5*100 = -500，capped 后 -400
    // 但 Math.max(0, ...) 保护
    expect(backoffDelayMs(0, cfg, () => 0)).toBe(0);
  });
});

describe("backoff: backoffConfigFromEnv", () => {
  it("无 env 时返回 DEFAULT_BACKOFF", () => {
    expect(backoffConfigFromEnv({})).toEqual(DEFAULT_BACKOFF);
  });

  it("INVOX_LLM_RETRIES=0 关闭重试", () => {
    const cfg = backoffConfigFromEnv({ INVOX_LLM_RETRIES: "0" });
    expect(cfg.maxRetries).toBe(0);
  });

  it("INVOX_LLM_RETRIES=5 / BASE / MAX 分别生效", () => {
    const cfg = backoffConfigFromEnv({
      INVOX_LLM_RETRIES: "5",
      INVOX_LLM_BACKOFF_BASE_MS: "200",
      INVOX_LLM_BACKOFF_MAX_MS: "20000",
    });
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.baseMs).toBe(200);
    expect(cfg.maxMs).toBe(20_000);
  });

  it("非法值（NaN / 负数）回退到默认", () => {
    const cfg = backoffConfigFromEnv({
      INVOX_LLM_RETRIES: "not-a-number",
      INVOX_LLM_BACKOFF_BASE_MS: "-1",
      INVOX_LLM_BACKOFF_MAX_MS: "abc",
    });
    expect(cfg).toEqual(DEFAULT_BACKOFF);
  });
});

describe("backoff: withConnectBackoff", () => {
  /** 用立即解析的 sleep stub，避免真等。 */
  const fakeSleep = async (): Promise<void> => Promise.resolve();

  it("首次成功不重试，task 仅调用一次", async () => {
    const task = vi.fn(async () => "ok");
    const r = await withConnectBackoff(task, DEFAULT_BACKOFF, {
      sleep: fakeSleep,
    });
    expect(r).toBe("ok");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("重试可恢复错误直到成功", async () => {
    let n = 0;
    const task = vi.fn(async () => {
      n += 1;
      if (n < 3) {
        const e = new Error("rate limited") as Error & { status: number };
        e.status = 429;
        throw e;
      }
      return "ok";
    });
    const onRetry = vi.fn();
    const r = await withConnectBackoff(
      task,
      { maxRetries: 5, baseMs: 1, maxMs: 10, jitter: 0 },
      { sleep: fakeSleep, onRetry, random: () => 0.5 },
    );
    expect(r).toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 1);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 2);
  });

  it("不可重试错误立刻冒泡，不触发 onRetry", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const task = vi.fn(async () => {
      throw err;
    });
    const onRetry = vi.fn();
    await expect(
      withConnectBackoff(task, DEFAULT_BACKOFF, {
        sleep: fakeSleep,
        onRetry,
      }),
    ).rejects.toThrow("bad request");
    expect(task).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("用尽 maxRetries 后冒泡最后一次错误", async () => {
    const err = Object.assign(new Error("boom"), { status: 503 });
    const task = vi.fn(async () => {
      throw err;
    });
    await expect(
      withConnectBackoff(
        task,
        { maxRetries: 2, baseMs: 1, maxMs: 10, jitter: 0 },
        { sleep: fakeSleep, random: () => 0.5 },
      ),
    ).rejects.toBe(err);
    // 首次 + 2 次重试 = 3 次
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("maxRetries=0 等同关闭重试", async () => {
    const err = Object.assign(new Error("boom"), { status: 503 });
    const task = vi.fn(async () => {
      throw err;
    });
    await expect(
      withConnectBackoff(
        task,
        { maxRetries: 0, baseMs: 1, maxMs: 10, jitter: 0 },
        { sleep: fakeSleep },
      ),
    ).rejects.toBe(err);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("AbortSignal 已 aborted 时立刻冒泡 AbortError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const task = vi.fn(async () => "ok");
    await expect(
      withConnectBackoff(task, DEFAULT_BACKOFF, {
        sleep: fakeSleep,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(task).not.toHaveBeenCalled();
  });

  it("sleep 期间 abort 立刻冒泡（默认 sleep 集成）", async () => {
    const err = Object.assign(new Error("rate"), { status: 429 });
    let calls = 0;
    const ctrl = new AbortController();
    const task = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // 第一次抛错，进入退避；安排 0ms 后 abort
        setTimeout(() => ctrl.abort(), 0);
      }
      throw err;
    });
    await expect(
      withConnectBackoff(
        task,
        { maxRetries: 5, baseMs: 1000, maxMs: 1000, jitter: 0 },
        { signal: ctrl.signal, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("onRetry 抛错不影响主流程（best-effort）", async () => {
    let n = 0;
    const task = vi.fn(async () => {
      n += 1;
      if (n < 2) {
        const e = new Error("retry me") as Error & { status: number };
        e.status = 502;
        throw e;
      }
      return "ok";
    });
    const onRetry = vi.fn(() => {
      throw new Error("hook explosion");
    });
    // onRetry 不该 throw —— 但若它真 throw，目前实现会让错误冒泡。这条
    // 测试明确记录当前行为：onRetry 必须不抛。如果未来要 best-effort 化，
    // 调整断言并更新 backoff.ts。
    await expect(
      withConnectBackoff(
        task,
        { maxRetries: 3, baseMs: 1, maxMs: 10, jitter: 0 },
        { sleep: fakeSleep, onRetry },
      ),
    ).rejects.toThrow("hook explosion");
  });
});
