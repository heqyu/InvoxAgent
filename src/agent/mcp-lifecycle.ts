// session ↔ MCP 进程池生命周期管理。
//
// 设计点：
//   - acquireMcp / releaseMcp 来自 mcp/pool.ts —— 进程级共享池，按 cwd 键控
//   - 每条 session 在 newSession / loadSession 时 acquire 一次，
//     deleteSession / 进程退出时 release 一次。计数失衡 = 子进程泄漏
//   - 这两个函数之前是 InvoxAgent 的私有方法；抽成 free function 是为了
//     A2 减重，行为完全不变（只是 `this` 不再需要）

import { createLogger } from "../log.js";
const log = createLogger("mcp-lifecycle");
import { acquireMcp, releaseMcp } from "../mcp/pool.js";
import type { Session } from "./session-types.js";

/**
 * 连接 .claude/.mcp.json 中定义的 MCP servers，把 manager 挂到 session 上。
 *
 * 优雅降级：配置缺失或某 server 启动失败，会话仍可继续，只是没 MCP 工具。
 *
 * 通过 mcp/pool.ts 的共享池获取 manager —— 同 cwd 的多个 session 共用一组
 * MCP 子进程。每次 acquire 必须在 session 销毁路径上对应一次 release（见
 * releaseSessionMcp），否则会泄漏子进程。
 */
export async function initMcpForSession(session: Session): Promise<void> {
  try {
    const mcp = await acquireMcp(session.cwd);
    if (mcp) {
      session.mcpClient = mcp;
      log.info("mcp connected for session", {
        sessionId: session.id,
        cwd: session.cwd,
        toolCount: mcp.getToolSpecs().length,
      });
    }
  } catch (e) {
    log.warn("mcp init failed", {
      sessionId: session.id,
      cwd: session.cwd,
      error: (e as Error).message,
    });
    // session 在没有 MCP 工具的情况下继续
  }
}

/**
 * 释放 session 持有的 MCP 池引用。所有 session 销毁路径
 * （deleteSession RPC、未来的连接断开路径）都必须经过这里。
 *
 * 幂等：mcpClient 为 undefined 时直接返回；release 失败仅 warn。
 */
export async function releaseSessionMcp(session: Session): Promise<void> {
  if (!session.mcpClient) return;
  session.mcpClient = undefined;
  await releaseMcp(session.cwd).catch((e) => {
    log.warn("mcp pool release error", {
      sessionId: session.id,
      cwd: session.cwd,
      error: (e as Error).message,
    });
  });
}
