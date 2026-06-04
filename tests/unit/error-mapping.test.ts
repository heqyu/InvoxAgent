// 单测：agent/error-mapping.ts —— classifyProviderError
//
// PROGRESS A5 / K9 —— LLM provider 错误到 ACP stopReason 的映射。
// 关键不变式：
//   1. AbortError → { kind: "abort" }（cancelled，不是失败）
//   2. HTTP 429 → category="rate_limit"
//   3. HTTP 401/403 → category="auth"
//   4. HTTP 5xx → category="server"
//   5. HTTP 4xx 其它 → category="bad_request"
//   6. Node 网络码（ECONNRESET 等）→ category="network"
//   7. 字符串模式 fetch failed → category="network"
//   8. 兜底 → category="unknown"
//   9. 永不抛异常（caller 假设它绝不抛）

import { describe, it, expect } from "vitest";
import {
  classifyProviderError,
  formatProviderErrorForUser,
  type ProviderErrorInfo,
} from "../../src/agent/error-mapping.js";

/** 构造一个 OpenAI APIError 风格的对象 —— 只 mock 必要字段。 */
function apiError(status: number, message = "upstream said no"): unknown {
  return { name: "APIError", status, message };
}

function nodeNetworkError(code: string, message = "network broken"): unknown {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

describe("classifyProviderError", () => {
  describe("AbortError → abort（cancellation）", () => {
    it("name=AbortError 识别", () => {
      const err = { name: "AbortError", message: "operation was aborted" };
      const r = classifyProviderError(err);
      expect(r.kind).toBe("abort");
    });

    it("message 含 'aborted' 也走 abort（兼容老 SDK）", () => {
      const err = new Error("The user aborted a request.");
      const r = classifyProviderError(err);
      expect(r.kind).toBe("abort");
    });
  });

  describe("HTTP 状态分桶", () => {
    it("429 → refusal / rate_limit，提示出现 HTTP 429", () => {
      const r = classifyProviderError(apiError(429, "too many requests"));
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") {
        expect(r.info.category).toBe("rate_limit");
        expect(r.info.status).toBe(429);
        expect(r.info.message).toMatch(/429/);
        expect(r.info.message).toMatch(/rate-limited/);
      }
    });

    it("401 → refusal / auth，提示 INVOX_API_KEY", () => {
      const r = classifyProviderError(apiError(401, "invalid token"));
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") {
        expect(r.info.category).toBe("auth");
        expect(r.info.message).toMatch(/INVOX_API_KEY/);
      }
    });

    it("403 → refusal / auth", () => {
      const r = classifyProviderError(apiError(403));
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") expect(r.info.category).toBe("auth");
    });

    it("500 → refusal / server", () => {
      const r = classifyProviderError(apiError(500, "internal"));
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") expect(r.info.category).toBe("server");
    });

    it("502 / 503 / 504 → refusal / server", () => {
      for (const s of [502, 503, 504]) {
        const r = classifyProviderError(apiError(s));
        if (r.kind === "refusal") expect(r.info.category).toBe("server");
      }
    });

    it("400 → refusal / bad_request（区别于 5xx）", () => {
      const r = classifyProviderError(apiError(400, "malformed body"));
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") expect(r.info.category).toBe("bad_request");
    });

    it("404 → refusal / bad_request（4xx 通用桶）", () => {
      const r = classifyProviderError(apiError(404, "model not found"));
      if (r.kind === "refusal") expect(r.info.category).toBe("bad_request");
    });
  });

  describe("Node 网络层错误码", () => {
    const codes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
    ];
    for (const code of codes) {
      it(`${code} → refusal / network`, () => {
        const r = classifyProviderError(nodeNetworkError(code));
        expect(r.kind).toBe("refusal");
        if (r.kind === "refusal") {
          expect(r.info.category).toBe("network");
          expect(r.info.code).toBe(code);
          expect(r.info.message).toContain(code);
        }
      });
    }
  });

  describe("字符串模式兜底", () => {
    it('"fetch failed" 走 network（无 status / 无 code）', () => {
      const err = new TypeError("fetch failed");
      const r = classifyProviderError(err);
      if (r.kind === "refusal") expect(r.info.category).toBe("network");
    });

    it("含 ECONNRESET 字串但没 code 字段也归 network", () => {
      const err = new Error("Stream interrupted: ECONNRESET");
      const r = classifyProviderError(err);
      if (r.kind === "refusal") expect(r.info.category).toBe("network");
    });
  });

  describe("兜底 unknown 桶", () => {
    it("纯 string 错误 → unknown", () => {
      const r = classifyProviderError("some weird thing");
      expect(r.kind).toBe("refusal");
      if (r.kind === "refusal") expect(r.info.category).toBe("unknown");
    });

    it("Error 不带 status / code 且 message 没匹配关键字 → unknown", () => {
      const r = classifyProviderError(new Error("model deprecated"));
      if (r.kind === "refusal") {
        expect(r.info.category).toBe("unknown");
        expect(r.info.message).toContain("model deprecated");
      }
    });

    it("null / undefined 不抛错", () => {
      expect(() => classifyProviderError(null)).not.toThrow();
      expect(() => classifyProviderError(undefined)).not.toThrow();
      const r = classifyProviderError(null);
      expect(r.kind).toBe("refusal");
    });

    it("过长 message 被截断到 200+1 字符以内", () => {
      const huge = "X".repeat(5000);
      const r = classifyProviderError(new Error(huge));
      if (r.kind === "refusal") {
        // message 应有 "…" 截断标记，且总长不应包含全部 5000 个 X
        expect(r.info.message.length).toBeLessThan(500);
        expect(r.info.message).toContain("…");
      }
    });
  });

  describe("不变式：永不抛异常", () => {
    const evilInputs: unknown[] = [
      null,
      undefined,
      0,
      "",
      false,
      [],
      {},
      Symbol("x"),
      { status: "not a number" },
      { status: 429 }, // no message
    ];
    for (const inp of evilInputs) {
      it(`不抛: ${String(inp)?.slice(0, 30)}`, () => {
        expect(() => classifyProviderError(inp)).not.toThrow();
      });
    }
  });
});

describe("formatProviderErrorForUser", () => {
  it("以 ⚠️ 开头便于客户端识别", () => {
    const info: ProviderErrorInfo = {
      category: "rate_limit",
      message: "Rate limited.",
      status: 429,
    };
    expect(formatProviderErrorForUser(info)).toBe("⚠️ Rate limited.");
  });
});
