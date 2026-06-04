// FlakyProvider — A5 / K9 acceptance harness.
//
// 模拟各种 provider 故障，让 invox 走 error-mapping 路径。具体故障类型
// 通过 INVOX_FLAKY_KIND env 选择：
//   - "429"        → 抛出 status=429 的 APIError 模拟（rate_limit）
//   - "500"        → 抛出 status=500 的 APIError 模拟（server）
//   - "auth"       → 抛出 status=401 的 APIError 模拟
//   - "network"    → 抛出 ECONNRESET 网络错误
//   - "mid-stream" → 先吐 1 个 text chunk 再抛 ECONNRESET（已开始流）
//   - 默认         → "429"
//
// 行为说明：
//   - "mid-stream" 之前已经流出一段文字，agent 应当先把这段写进 history
//     再走 refusal 收尾 —— 这是 PROGRESS A5 验收里"流到一半挂掉"场景。
//   - 其它 kind 在 stream 第一个 yield 之前就抛，模拟"还没开始就 429"。

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
    // default "429"
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
