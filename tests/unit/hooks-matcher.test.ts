// 单测：plugins/hooks.ts 的 matchesTool 纯函数
//
// PROGRESS A1 硬指标 ——「hook matcher 正则」覆盖。
// 范围：仅纯函数；hook 加载与命令执行另文件覆盖。

import { describe, it, expect } from "vitest";
import { matchesTool } from "../../src/plugins/hooks.js";

describe("matchesTool", () => {
  describe("empty / undefined matcher", () => {
    it("undefined matcher 应匹配任意工具", () => {
      expect(matchesTool(undefined, "Write")).toBe(true);
      expect(matchesTool(undefined, "")).toBe(true);
    });

    it("空字符串 matcher 应匹配任意工具（default-allow 语义）", () => {
      expect(matchesTool("", "Bash")).toBe(true);
    });
  });

  describe("正常正则", () => {
    it("精确字面量匹配", () => {
      expect(matchesTool("Write", "Write")).toBe(true);
      expect(matchesTool("Write", "WriteFile")).toBe(true); // 子串即匹配
      expect(matchesTool("Write", "Read")).toBe(false);
    });

    it("管道(or) 匹配", () => {
      expect(matchesTool("Write|Edit", "Write")).toBe(true);
      expect(matchesTool("Write|Edit", "Edit")).toBe(true);
      expect(matchesTool("Write|Edit", "Read")).toBe(false);
    });

    it("锚定 ^...$ 强制全匹配", () => {
      expect(matchesTool("^Write$", "Write")).toBe(true);
      expect(matchesTool("^Write$", "WriteFile")).toBe(false);
    });

    it("MCP 工具命名前缀匹配", () => {
      expect(matchesTool("^mcp__", "mcp__github__create_issue")).toBe(true);
      expect(matchesTool("^mcp__", "Write")).toBe(false);
    });

    it("大小写敏感（默认正则语义）", () => {
      expect(matchesTool("write", "Write")).toBe(false);
      expect(matchesTool("(?i)write", "Write")).toBe(false); // JS 不支持 (?i)
    });
  });

  describe("非法正则的退化路径", () => {
    it("未闭合括号应退化为字面量精确匹配，且不抛错", () => {
      // "(" 是非法正则
      expect(() => matchesTool("(", "(")).not.toThrow();
      // 字面量匹配：matcher === toolName
      expect(matchesTool("(", "(")).toBe(true);
      expect(matchesTool("(", "Write")).toBe(false);
    });

    it("非法转义 \\ 在结尾时同样不应抛错", () => {
      expect(() => matchesTool("\\", "Write")).not.toThrow();
      // 退化为字面量后不等
      expect(matchesTool("\\", "Write")).toBe(false);
      expect(matchesTool("\\", "\\")).toBe(true);
    });
  });
});
