// MCP 进程级共享池。
//
// 背景：旧实现 InvoxAgent.initMcpForSession 每个 session 都 new
// McpClientManager()，spawn 全套 MCP 子进程。同 cwd 开 N 个 session =
// 3N 个子进程 + 3 倍 fd。Zed 这种长时间挂着的客户端极易把僵尸进程留在 OS 里。
//
// 解决：进程级 singleton 池，按 cwd 键控（mcp config 是从 cwd 读的，
// 同 cwd 的不同 session 加载到的 server 列表一致，可安全复用）。
//
// 引用计数语义：
//   - acquireMcp(cwd)  → refCount += 1，首次创建并真 spawn
//   - releaseMcp(cwd)  → refCount -= 1，归零时真 disconnect
//   - disposeAllMcp()  → 进程退出兜底，无视计数全部 disconnect
//
// 并发去重：同 cwd 多个 session 并发 acquire 时只 connect 一次（in-flight
// promise），其余复用结果。

import { createLogger } from "../log.js";
const log = createLogger("mcp");
import { McpClientManager } from "./client.js";
import { loadMcpConfig } from "./config.js";

/** 池中单条记录。 */
interface PoolEntry {
  manager: McpClientManager;
  refCount: number;
  cwd: string;
}

/**
 * 测试可注入的工厂：用来跳过真实 spawn / connect。生产默认走 defaultFactory。
 *
 * 返回 null 表示该 cwd 上无可用 MCP 配置或无可用工具，调用方应自然降级
 * 而非抛错。
 */
export type McpManagerFactory = (
  cwd: string,
) => Promise<McpClientManager | null>;

const pool = new Map<string, PoolEntry>();
/** 同 cwd 并发 acquire 时去重，避免重复 spawn。 */
const inflight = new Map<string, Promise<McpClientManager | null>>();

let factory: McpManagerFactory = defaultFactory;

/**
 * 标准创建路径：读 cwd/.claude/.mcp.json → spawn → listTools。
 * 任一步失败或没拉到任何工具都返回 null（让池不收记录，避免空 manager）。
 */
async function defaultFactory(cwd: string): Promise<McpClientManager | null> {
  const config = loadMcpConfig(cwd);
  if (!config) return null;
  const m = new McpClientManager();
  await m.connect(config.mcpServers);
  if (m.getToolSpecs().length === 0) {
    // 配置存在但没拉到任何工具 —— 立即释放子进程，不入池
    await m.disconnect().catch(() => {});
    return null;
  }
  return m;
}

/**
 * 获取一个 MCP manager（引用计数 +1）。
 *
 * 返回 null 表示该 cwd 没有可用 MCP 配置；调用方应忽略 mcp 工具集，
 * 不要把 null 当 manager 用。
 *
 * **重要**：每次成功 acquire（返回非 null）都必须有一次对应的 releaseMcp(cwd)，
 * 否则会泄漏子进程。
 */
export async function acquireMcp(
  cwd: string,
): Promise<McpClientManager | null> {
  const k = cwd;

  // 已在池中：直接 +1
  const existing = pool.get(k);
  if (existing) {
    existing.refCount += 1;
    log.debug("mcp pool: reuse", {
      cwd,
      refCount: existing.refCount,
    });
    return existing.manager;
  }

  // 同 cwd 已有人在创建：等同一个 promise，避免重复 spawn
  const ongoing = inflight.get(k);
  if (ongoing) {
    const m = await ongoing;
    if (m) {
      const e = pool.get(k);
      if (e) {
        e.refCount += 1;
        log.debug("mcp pool: reuse-after-inflight", {
          cwd,
          refCount: e.refCount,
        });
        return e.manager;
      }
    }
    return m;
  }

  // 首次创建
  const promise = (async (): Promise<McpClientManager | null> => {
    const m = await factory(cwd);
    if (m) {
      pool.set(k, { manager: m, refCount: 1, cwd });
      log.info("mcp pool: created", { cwd });
    }
    return m;
  })();
  inflight.set(k, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(k);
  }
}

/**
 * 释放一次引用。归零时真正 disconnect 子进程并从池中移除。
 * 可重入安全：不在池内 / 已经归零再 release 都是 no-op。
 */
export async function releaseMcp(cwd: string): Promise<void> {
  const k = cwd;
  const entry = pool.get(k);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    log.debug("mcp pool: release", { cwd, refCount: entry.refCount });
    return;
  }
  pool.delete(k);
  try {
    await entry.manager.disconnect();
    log.info("mcp pool: disposed (refCount=0)", { cwd });
  } catch (e) {
    log.warn("mcp pool: disconnect error on release", {
      cwd,
      error: (e as Error).message,
    });
  }
}

/**
 * 进程退出兜底：无视引用计数把所有 manager disconnect 并清空池。
 * 在 cli.ts 的 SIGINT / SIGTERM / stdin-end 路径调用，确保不留僵尸子进程。
 * 幂等，可多次调用。
 */
export async function disposeAllMcp(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  if (entries.length === 0) return;
  log.info("mcp pool: disposeAll", { count: entries.length });
  await Promise.all(
    entries.map((e) =>
      e.manager.disconnect().catch((err) => {
        log.warn("mcp pool: disconnect error on disposeAll", {
          cwd: e.cwd,
          error: (err as Error).message,
        });
      }),
    ),
  );
}

// ── 测试辅助 ────────────────────────────────────────────────────────

/** 注入自定义 factory（仅测试用）；传 null 恢复默认路径。 */
export function _setMcpFactoryForTest(f: McpManagerFactory | null): void {
  factory = f ?? defaultFactory;
}

/** 池快照（仅测试用）。 */
export function _poolSnapshot(): { cwd: string; refCount: number }[] {
  return [...pool.values()].map((e) => ({ cwd: e.cwd, refCount: e.refCount }));
}

/** 清空池但不调 disconnect（仅测试 setup/teardown 用）。 */
export function _resetPoolForTest(): void {
  pool.clear();
  inflight.clear();
}
