// 单测：agent/usage-meter.ts —— accumulateTurnUsage 与 emptyTurnUsage
//
// PROGRESS A1 硬指标 ——「agent 的 maxPrompt 计费」覆盖。
// 关键不变式：
//   1. calls 是调用次数
//   2. input/output/total/cached 是各次调用的求和（billing 维度）
//   3. maxPrompt 是单次 input 的最大值（context 占用维度）
//   4. maxCached 必须来自 maxPrompt 所在那一次（领带时取较优）

import { describe, it, expect } from "vitest";
import {
  accumulateTurnUsage,
  emptyTurnUsage,
  type TurnUsage,
} from "../../src/agent/usage-meter.js";
import type { UsageInfo } from "../../src/llm/types.js";

function usage(input: number, output: number, cached = 0): UsageInfo {
  return { input, output, total: input + output, cached };
}

describe("emptyTurnUsage", () => {
  it("所有字段初始为 0", () => {
    const u = emptyTurnUsage();
    expect(u).toEqual({
      input: 0,
      output: 0,
      total: 0,
      calls: 0,
      cached: 0,
      maxPrompt: 0,
      maxCached: 0,
    });
  });

  it("两次 emptyTurnUsage() 互不引用同一对象", () => {
    const a = emptyTurnUsage();
    const b = emptyTurnUsage();
    a.input = 999;
    expect(b.input).toBe(0);
  });
});

describe("accumulateTurnUsage", () => {
  it("单次累加：所有字段直接生效", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(100, 50, 20));
    expect(u).toEqual({
      input: 100,
      output: 50,
      total: 150,
      calls: 1,
      cached: 20,
      maxPrompt: 100,
      maxCached: 20,
    });
  });

  it("多次累加：input/output/total/cached 求和", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(100, 50, 10));
    accumulateTurnUsage(u, usage(200, 80, 30));
    accumulateTurnUsage(u, usage(50, 20, 5));
    expect(u.input).toBe(350);
    expect(u.output).toBe(150);
    expect(u.total).toBe(500);
    expect(u.cached).toBe(45);
    expect(u.calls).toBe(3);
  });

  it("maxPrompt 是单次 input 的最大值（不是求和）", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(100, 10));
    accumulateTurnUsage(u, usage(300, 10));
    accumulateTurnUsage(u, usage(50, 10));
    expect(u.maxPrompt).toBe(300);
  });

  it("maxCached 与 maxPrompt 配对：新最大值出现时重置 maxCached", () => {
    const u = emptyTurnUsage();
    // 第一次：input=100, cached=80（cache 命中率高）
    accumulateTurnUsage(u, usage(100, 10, 80));
    expect(u.maxPrompt).toBe(100);
    expect(u.maxCached).toBe(80);

    // 第二次：input=200（更大），cached=10（命中率低）—— maxCached 应重置为 10
    accumulateTurnUsage(u, usage(200, 10, 10));
    expect(u.maxPrompt).toBe(200);
    expect(u.maxCached).toBe(10);
  });

  it("maxPrompt 领带时 maxCached 取较大值（更乐观）", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(100, 10, 30));
    accumulateTurnUsage(u, usage(100, 10, 60)); // 同 input，更高 cache
    expect(u.maxPrompt).toBe(100);
    expect(u.maxCached).toBe(60);

    accumulateTurnUsage(u, usage(100, 10, 20)); // 同 input，更低 cache —— 不降
    expect(u.maxCached).toBe(60);
  });

  it("已有较大 maxPrompt 时小调用不影响", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(500, 100, 200));
    accumulateTurnUsage(u, usage(100, 50, 80));
    expect(u.maxPrompt).toBe(500);
    expect(u.maxCached).toBe(200);
    // 但累计字段仍正确求和
    expect(u.input).toBe(600);
    expect(u.cached).toBe(280);
  });

  it("零值调用：calls 仍递增，max 不变", () => {
    const u = emptyTurnUsage();
    accumulateTurnUsage(u, usage(0, 0, 0));
    expect(u.calls).toBe(1);
    expect(u.maxPrompt).toBe(0);
    expect(u.maxCached).toBe(0);
  });

  it("引用语义：函数就地修改传入对象，不返回新对象", () => {
    const u: TurnUsage = emptyTurnUsage();
    const ret = accumulateTurnUsage(u, usage(10, 5));
    expect(ret).toBeUndefined();
    expect(u.calls).toBe(1);
  });
});
