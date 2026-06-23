// Session 工厂 —— 唯一的 Session 构造点。
//
// 设计意图（J1.1）：
//   消除 agent.ts newSession / loadSession / sub-agent-runner.ts 三处
//   Session 构造的重复，确保新增字段时只改一处。
//
// mcpClient / sessionLog 在 newSession / loadSession 路径上由 caller
// **异步**填充（initMcpForSession / openSessionLogFile）；工厂只接收
// 预先准备好的引用或留空。

import { randomUUID } from "node:crypto";
import { FileCache } from "../tools/cache.js";
import type { HookRegistry } from "../plugins/hooks.js";
import type { McpClientManager } from "../mcp/client.js";
import type { LLMMessage } from "../llm/types.js";
import type { Session, PersistedTurnUsage } from "./session-types.js";
import type { SessionStore } from "../persistence.js";
import type { LogFile } from "../log.js";
import { emptyTurnUsage } from "./usage-meter.js";

export interface SessionInitOptions {
  /** 不传则 randomUUID()；loadSession / sub-agent 显式传入。 */
  id?: string;
  cwd: string;
  history: LLMMessage[];
  /** subagent 必传（父的）；newSession / loadSession 由 caller 调 loadHooks 后传入。 */
  hooks: HookRegistry;
  /** subagent 复用父的；其它路径走 initMcpForSession 异步设置（不在工厂里）。 */
  mcpClient?: McpClientManager;
  selectedModel?: string;
  configValues?: Record<string, string>;
  createdAt?: number;
  lastTurnUsage?: PersistedTurnUsage;
  sessionLog?: LogFile;
  /**
   * 外部构造的 AbortController —— sub-agent 需要传入联动父 abort 的版本。
   * 不传时工厂自动创建新的。
   */
  abort?: AbortController;
  /** loadSession 时传入，newSession / sub-agent 不传。 */
  store?: SessionStore;
}

/**
 * 唯一 Session 构造点。新增字段时只改这里。
 *
 * 注意：mcpClient / sessionLog 在 newSession / loadSession 路径上由 caller
 * **异步**填充（initMcpForSession / openSessionLogFile）；工厂只接收预先准备
 * 好的引用或留空。
 */
export function createSession(opts: SessionInitOptions): Session {
  return {
    id: opts.id ?? randomUUID(),
    cwd: opts.cwd,
    history: opts.history,
    abort: opts.abort ?? new AbortController(),
    toolState: { readPaths: new Set<string>(), cache: new FileCache() },
    createdAt: opts.createdAt ?? Date.now(),
    configValues: opts.configValues ?? {},
    turnUsage: emptyTurnUsage(),
    turnStartedAt: 0,
    hooks: opts.hooks,
    ...(opts.selectedModel ? { selectedModel: opts.selectedModel } : {}),
    ...(opts.mcpClient ? { mcpClient: opts.mcpClient } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.lastTurnUsage ? { lastTurnUsage: opts.lastTurnUsage } : {}),
    ...(opts.sessionLog ? { sessionLog: opts.sessionLog } : {}),
  };
}
