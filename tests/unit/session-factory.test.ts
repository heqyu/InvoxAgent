// 单测：agent/session-factory.ts —— createSession 工厂函数
//
// J1.1 新增。验证唯一 Session 构造点的默认值、可选字段、ID 生成。

import { describe, it, expect } from "vitest";
import { createSession } from "../../src/agent/session-factory.js";
import type { HookRegistry } from "../../src/plugins/hooks.js";

/** 最小合法 opts —— 只传必填字段。 */
const minimalOpts = {
  cwd: "/tmp/test",
  history: [],
  hooks: {} as HookRegistry,
};

describe("createSession", () => {
  it("默认字段齐全：abort 是新 AbortController、turnUsage 空、readPaths 空 Set 等", () => {
    const session = createSession(minimalOpts);

    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");
    expect(session.cwd).toBe("/tmp/test");
    expect(session.history).toEqual([]);
    expect(session.abort).toBeInstanceOf(AbortController);
    expect(session.abort.signal.aborted).toBe(false);
    expect(session.toolState.readPaths).toBeInstanceOf(Set);
    expect(session.toolState.readPaths.size).toBe(0);
    expect(session.toolState.cache).toBeDefined();
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.configValues).toEqual({});
    expect(session.turnUsage).toEqual({
      input: 0,
      output: 0,
      total: 0,
      calls: 0,
      cached: 0,
      maxPrompt: 0,
      maxCached: 0,
    });
    expect(session.turnStartedAt).toBe(0);
    expect(session.hooks).toBe(minimalOpts.hooks);
    // 可选字段默认不存在
    expect(session.selectedModel).toBeUndefined();
    expect(session.mcpClient).toBeUndefined();
    expect(session.lastTurnUsage).toBeUndefined();
    expect(session.sessionLog).toBeUndefined();
    expect(session.store).toBeUndefined();
  });

  it("可选字段：mcpClient / selectedModel / lastTurnUsage / sessionLog 传与不传的双向对称", () => {
    const full = createSession({
      ...minimalOpts,
      selectedModel: "gpt-4o",
      mcpClient: { fake: true } as any,
      lastTurnUsage: {
        input: 100,
        output: 50,
        total: 150,
        calls: 1,
        maxPrompt: 100,
        maxCached: 0,
        cached: 0,
        elapsedMs: 1000,
        model: "gpt-4o",
      },
      sessionLog: { write: () => {}, close: () => {}, path: "/tmp/test.log" } as any,
      configValues: { thinking: "low" },
      createdAt: 12345,
      store: { fake: true } as any,
    });

    expect(full.selectedModel).toBe("gpt-4o");
    // mcpClient: 传了 truthy 值 → 工厂会 spread 进去
    expect((full as any).mcpClient).toEqual({ fake: true });
    expect(full.lastTurnUsage).toBeDefined();
    expect(full.lastTurnUsage!.model).toBe("gpt-4o");
    expect(full.sessionLog).toBeDefined();
    expect(full.configValues).toEqual({ thinking: "low" });
    expect(full.createdAt).toBe(12345);
    expect((full as any).store).toEqual({ fake: true });

    // 不传时全部 undefined
    const minimal = createSession(minimalOpts);
    expect(minimal.selectedModel).toBeUndefined();
    expect(minimal.mcpClient).toBeUndefined();
    expect(minimal.lastTurnUsage).toBeUndefined();
    expect(minimal.sessionLog).toBeUndefined();
    expect(minimal.store).toBeUndefined();
  });

  it("不传 id 时自动生成 UUID v4 格式", () => {
    const s1 = createSession(minimalOpts);
    const s2 = createSession(minimalOpts);

    // UUID v4 格式：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(s1.id).toMatch(uuidRe);
    expect(s2.id).toMatch(uuidRe);
    // 两次生成不同
    expect(s1.id).not.toBe(s2.id);
  });

  it("传入 id 时原样使用", () => {
    const s = createSession({ ...minimalOpts, id: "custom-id-123" });
    expect(s.id).toBe("custom-id-123");
  });

  it("传入 abort 时使用提供的 AbortController", () => {
    const ac = new AbortController();
    const s = createSession({ ...minimalOpts, abort: ac });
    expect(s.abort).toBe(ac);
  });
});
