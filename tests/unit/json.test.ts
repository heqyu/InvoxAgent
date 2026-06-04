// 单测：agent/json.ts —— safeParseJSON 与 parseToolArguments
//
// PROGRESS A3 / K5：覆盖 LLM tool_call 参数的容错解析。
// 关键不变式：
//   1. 空字符串 / 仅空白 → ok({})
//   2. 合法 JSON object → ok(value)
//   3. 非对象（数组、字符串、数字、null、布尔）→ err，error 有"got <kind>"
//   4. 畸形 JSON → err，error 含 LLM 实际给的 preview（≤ 200 字符）
//   5. 永不抛出异常（caller 假设它绝不抛）

import { describe, it, expect } from "vitest";
import {
  safeParseJSON,
  parseToolArguments,
} from "../../src/agent/json.js";

describe("safeParseJSON", () => {
  it("合法 object 返回原对象", () => {
    expect(safeParseJSON('{"a": 1}')).toEqual({ a: 1 });
    expect(safeParseJSON('{"path":"src/foo.ts","offset":10}')).toEqual({
      path: "src/foo.ts",
      offset: 10,
    });
  });

  it("空字符串返回 null", () => {
    expect(safeParseJSON("")).toBeNull();
  });

  it("非法 JSON 返回 null（不抛错）", () => {
    expect(() => safeParseJSON("{not-json")).not.toThrow();
    expect(safeParseJSON("{not-json")).toBeNull();
    expect(safeParseJSON("{a:1,}")).toBeNull(); // trailing comma
    expect(safeParseJSON('{"a"')).toBeNull(); // 截断
  });

  it("顶层数组返回 null（tool args 必须是 object）", () => {
    expect(safeParseJSON("[1,2,3]")).toBeNull();
  });

  it("顶层标量返回 null", () => {
    expect(safeParseJSON('"hello"')).toBeNull();
    expect(safeParseJSON("42")).toBeNull();
    expect(safeParseJSON("true")).toBeNull();
    expect(safeParseJSON("null")).toBeNull();
  });

  it("空对象 {} 是合法的（ok）", () => {
    expect(safeParseJSON("{}")).toEqual({});
  });

  it("嵌套对象保留结构", () => {
    expect(safeParseJSON('{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } });
  });
});

describe("parseToolArguments", () => {
  it("空字符串 → ok({})", () => {
    expect(parseToolArguments("")).toEqual({ ok: true, value: {} });
  });

  it("仅空白字符 → ok({})", () => {
    expect(parseToolArguments("   ")).toEqual({ ok: true, value: {} });
    expect(parseToolArguments("\n\t  ")).toEqual({ ok: true, value: {} });
  });

  it("合法 object → ok(value)", () => {
    const r = parseToolArguments('{"path":"src/foo.ts"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ path: "src/foo.ts" });
  });

  it("空 object → ok({})", () => {
    const r = parseToolArguments("{}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it("非法 JSON → err，error 含 'not valid JSON'", () => {
    const r = parseToolArguments("{not-json:::");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not valid JSON/);
      // 应附带 received preview
      expect(r.error).toMatch(/Received:/);
      expect(r.error).toContain("{not-json");
    }
  });

  it("非法 JSON 的 preview 截断到 200 字符", () => {
    const big = "{" + "a".repeat(500); // 永远不能闭合
    const r = parseToolArguments(big);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // preview 应含截断标记
      expect(r.error).toContain("…");
      // error 文本不应超过原始 500a + 一些固定文本
      expect(r.error.length).toBeLessThan(500);
    }
  });

  it("顶层数组 → err，message 提到 array", () => {
    const r = parseToolArguments("[1,2,3]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/array/);
  });

  it("顶层字符串 → err，message 提到 string", () => {
    const r = parseToolArguments('"just a string"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/string/);
  });

  it("顶层 null → err", () => {
    const r = parseToolArguments("null");
    expect(r.ok).toBe(false);
  });

  it("顶层 boolean → err", () => {
    const r = parseToolArguments("true");
    expect(r.ok).toBe(false);
  });

  it("顶层 number → err", () => {
    const r = parseToolArguments("42");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/number/);
  });

  it("不变式：永不抛异常（畸形输入矩阵）", () => {
    const evilInputs = [
      "",
      "{",
      "}",
      "{}",
      "[",
      '{"a":}',
      '{"a":undefined}',
      "Infinity",
      "NaN",
      'undefined',
      '\u0000',
      '{"a":' + "\u0001".repeat(10) + "}",
    ];
    for (const inp of evilInputs) {
      expect(() => parseToolArguments(inp)).not.toThrow();
    }
  });
});
