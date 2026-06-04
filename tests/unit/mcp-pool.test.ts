// MCP 进程池单元测试 —— B1 / K3 验收。
//
// 不真实 spawn 子进程：用 _setMcpFactoryForTest 注入 fake manager，专注
// 验证池语义（引用计数 / 并发去重 / 释放路径 / disposeAll 兜底）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMcp,
  disposeAllMcp,
  releaseMcp,
  _poolSnapshot,
  _resetPoolForTest,
  _setMcpFactoryForTest,
  type McpManagerFactory,
} from "../../src/mcp/pool.js";
import type { McpClientManager } from "../../src/mcp/client.js";

/**
 * 构造一个最小可用的 McpClientManager 替身。我们只关心 `disconnect` 是否
 * 被精确调用一次以及 `getToolSpecs` 用于 default factory 的健康检查；其他
 * 方法在 pool 单测中不会触发，stub 成 throw 以确保意外触达能被捕捉到。
 */
function fakeManager(): McpClientManager & {
  disconnectCount: () => number;
} {
  let disconnects = 0;
  const m: Partial<McpClientManager> & { disconnectCount?: () => number } = {
    disconnect: vi.fn(async () => {
      disconnects += 1;
    }) as unknown as McpClientManager["disconnect"],
    // 池逻辑不会调用其他方法；保险起见 throw
    connect: (() => {
      throw new Error("fakeManager.connect should not be called from pool");
    }) as unknown as McpClientManager["connect"],
    getToolSpecs: (() => []) as unknown as McpClientManager["getToolSpecs"],
    getMcpTool: (() => undefined) as unknown as McpClientManager["getMcpTool"],
    callTool: (() => {
      throw new Error("fakeManager.callTool not stubbed");
    }) as unknown as McpClientManager["callTool"],
  };
  m.disconnectCount = () => disconnects;
  return m as McpClientManager & { disconnectCount: () => number };
}

describe("mcp pool (B1 / K3)", () => {
  beforeEach(() => {
    _resetPoolForTest();
  });

  afterEach(() => {
    _setMcpFactoryForTest(null);
    _resetPoolForTest();
  });

  it("acquireMcp(cwd) 首次创建时调用 factory 一次，refCount=1", async () => {
    const m = fakeManager();
    const factory = vi.fn(async () => m);
    _setMcpFactoryForTest(factory);

    const got = await acquireMcp("/cwd1");
    expect(got).toBe(m);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 1 }]);
  });

  it("同 cwd 多次 acquire 复用 manager，refCount 正确累加", async () => {
    const m = fakeManager();
    const factory = vi.fn(async () => m);
    _setMcpFactoryForTest(factory);

    const a = await acquireMcp("/cwd1");
    const b = await acquireMcp("/cwd1");
    const c = await acquireMcp("/cwd1");

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(factory).toHaveBeenCalledTimes(1); // 只创建一次
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 3 }]);
  });

  it("不同 cwd 各自独立的 manager", async () => {
    const m1 = fakeManager();
    const m2 = fakeManager();
    const factory: McpManagerFactory = async (cwd) =>
      cwd === "/cwd1" ? m1 : m2;
    _setMcpFactoryForTest(factory);

    const a = await acquireMcp("/cwd1");
    const b = await acquireMcp("/cwd2");

    expect(a).toBe(m1);
    expect(b).toBe(m2);
    expect(_poolSnapshot()).toHaveLength(2);
  });

  it("factory 返回 null 表示无 mcp 配置 —— 不入池，不报错", async () => {
    _setMcpFactoryForTest(async () => null);
    const got = await acquireMcp("/no-mcp");
    expect(got).toBeNull();
    expect(_poolSnapshot()).toEqual([]);
  });

  it("releaseMcp 减引用计数；归零时 disconnect 一次并出池", async () => {
    const m = fakeManager();
    _setMcpFactoryForTest(async () => m);

    await acquireMcp("/cwd1");
    await acquireMcp("/cwd1");
    await acquireMcp("/cwd1");
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 3 }]);

    await releaseMcp("/cwd1");
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 2 }]);
    expect(m.disconnectCount()).toBe(0); // 还没归零

    await releaseMcp("/cwd1");
    await releaseMcp("/cwd1");
    expect(_poolSnapshot()).toEqual([]); // 归零出池
    expect(m.disconnectCount()).toBe(1); // 仅在归零时 disconnect 一次
  });

  it("超额 release 是 no-op（不抛、不二次 disconnect）", async () => {
    const m = fakeManager();
    _setMcpFactoryForTest(async () => m);

    await acquireMcp("/cwd1");
    await releaseMcp("/cwd1"); // refCount→0，disconnect
    expect(m.disconnectCount()).toBe(1);

    // 多余的 release 应当静默忽略
    await releaseMcp("/cwd1");
    await releaseMcp("/cwd1");
    expect(m.disconnectCount()).toBe(1);
  });

  it("release 完后再 acquire 同 cwd → 重新创建", async () => {
    const m1 = fakeManager();
    const m2 = fakeManager();
    let call = 0;
    _setMcpFactoryForTest(async () => {
      call += 1;
      return call === 1 ? m1 : m2;
    });

    const a = await acquireMcp("/cwd1");
    await releaseMcp("/cwd1");
    const b = await acquireMcp("/cwd1");

    expect(a).toBe(m1);
    expect(b).toBe(m2); // 新 manager
    expect(call).toBe(2);
    expect(m1.disconnectCount()).toBe(1);
  });

  it("并发 acquire 同 cwd 只触发一次 factory（in-flight 去重）", async () => {
    const m = fakeManager();
    const factory = vi.fn(async () => {
      // 模拟 connect 慢
      await new Promise((r) => setTimeout(r, 10));
      return m;
    });
    _setMcpFactoryForTest(factory);

    const [a, b, c] = await Promise.all([
      acquireMcp("/cwd1"),
      acquireMcp("/cwd1"),
      acquireMcp("/cwd1"),
    ]);

    expect(a).toBe(m);
    expect(b).toBe(m);
    expect(c).toBe(m);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 3 }]);
  });

  it("disposeAllMcp 无视计数全部 disconnect 并清空池", async () => {
    const m1 = fakeManager();
    const m2 = fakeManager();
    const factory: McpManagerFactory = async (cwd) =>
      cwd === "/a" ? m1 : m2;
    _setMcpFactoryForTest(factory);

    await acquireMcp("/a");
    await acquireMcp("/a"); // refCount=2
    await acquireMcp("/b");

    expect(_poolSnapshot()).toHaveLength(2);

    await disposeAllMcp();

    expect(_poolSnapshot()).toEqual([]);
    expect(m1.disconnectCount()).toBe(1);
    expect(m2.disconnectCount()).toBe(1);
  });

  it("disposeAllMcp 幂等（多次调用安全）", async () => {
    const m = fakeManager();
    _setMcpFactoryForTest(async () => m);
    await acquireMcp("/cwd1");

    await disposeAllMcp();
    await disposeAllMcp();
    await disposeAllMcp();

    expect(m.disconnectCount()).toBe(1); // 仅一次
  });

  it("factory 抛错时不污染池（in-flight 清理）", async () => {
    let attempt = 0;
    const m = fakeManager();
    _setMcpFactoryForTest(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return m;
    });

    await expect(acquireMcp("/cwd1")).rejects.toThrow("transient");
    expect(_poolSnapshot()).toEqual([]); // 未入池

    // 第二次调用应当能正常重试
    const got = await acquireMcp("/cwd1");
    expect(got).toBe(m);
    expect(_poolSnapshot()).toEqual([{ cwd: "/cwd1", refCount: 1 }]);
  });

  it("disconnect 抛错不影响池状态（已删条目，错误仅 warn）", async () => {
    const m: McpClientManager = {
      disconnect: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as McpClientManager["disconnect"],
    } as unknown as McpClientManager;
    _setMcpFactoryForTest(async () => m);

    await acquireMcp("/cwd1");
    await releaseMcp("/cwd1"); // 内部 catch 掉错误
    expect(_poolSnapshot()).toEqual([]); // 仍然出池
  });
});
