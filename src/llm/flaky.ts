// 模拟各种 provider 故障的 mock —— 用来验证 invox 的错误映射 / refusal 通路。
// 故障类型由 INVOX_FLAKY_KIND env 选择：
//   "429"        → status=429（rate_limit）
//   "500"        → status=500（server）
//   "auth"       → status=401（auth 失败）
//   "network"    → ECONNRESET 网络错误
//   "mid-stream" → 先吐 1 个 text chunk 再抛 ECONNRESET（"已开始流"场景）
//   默认         → "429"
//
// "mid-stream" 之前已经流出文字，agent 应当先把它写进 history 再走 refusal 收尾；
// 其它 kind 在第一个 yield 之前就抛，对应"还没开始就 429"。

import type { LLMDelta, LLMProvider, LLMRequest } from "./types.js";
import { sleep } from "./utils.js";

export type FlakyKind = "429" | "500" | "auth" | "network" | "mid-stream";

export class FlakyProvider implements LLMProvider {
  readonly name: string;
  constructor(private readonly kind: FlakyKind = "429") {
    this.name = `mock-flaky-${kind}`;
  }

  async *stream(_req: LLMRequest): AsyncIterable<LLMDelta> {
    if (this.kind === "mid-stream") {
      // 先吐一些 text 模拟「已开始流」
      yield { kind: "text", text: "Starting reply" };
      await sleep(5);
      yield { kind: "text", text: ", but then" };
      // 再抛网络错误
      throw makeNetworkError("ECONNRESET", "stream interrupted mid-flight");
    }
    if (this.kind === "network") {
      throw makeNetworkError("ECONNRESET", "connection reset by peer");
    }
    if (this.kind === "auth") {
      throw makeApiError(401, "invalid api key");
    }
    if (this.kind === "500") {
      throw makeApiError(500, "internal server error");
    }
    // 默认 "429"
    throw makeApiError(429, "rate limit exceeded; retry after 30s");
  }
}

// ── 内部 ─────────────────────────────────────────────────────────────

function makeApiError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number; name: string };
  e.name = "APIError";
  e.status = status;
  return e;
}

function makeNetworkError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
