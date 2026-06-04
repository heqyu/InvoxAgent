// 杂项 agent helpers —— Phase A2.4 拆分
//
// 从 agent.ts 抽出两个完全无类依赖的 helper：
//   - agentVersion()  —— 读取并缓存 package.json 的 version 字段
//   - maxIterations() —— 从 INVOX_MAX_ITERATIONS env 读最大迭代数（默认 50）
//
// 这些是流程性 helper，与 LLM / 协议 / 工具子系统无关。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the agent package version once, cache for the process lifetime. */
let _agentVersion: string | undefined;

/**
 * 读取 invox 自身的 package.json version 字段（用于 hook context、
 * MCP client identity 等）。失败时返回 "unknown"，永不抛错。
 *
 * NOTE: 路径解析存在 pre-existing 缺陷 —— `join(__dirname, "..", ...)`
 * 在 dev 模式（tsx, __dirname=src/agent）下指向 src/package.json，在
 * dist 模式（__dirname=dist/agent）下指向 dist/package.json，两个都不存
 * 在，所以本函数实际上一直返回 "unknown"。A2.4 纪律是搬不修，登记为
 * Backlog 待修；当前调用方（hookBase）只把它作为诊断字段塞进 hook stdin，
 * 误差容忍度高。
 */
export function agentVersion(): string {
  if (!_agentVersion) {
    try {
      const p = join(__dirname, "..", "package.json");
      _agentVersion = (
        JSON.parse(readFileSync(p, "utf8")) as { version: string }
      ).version;
    } catch {
      _agentVersion = "unknown";
    }
  }
  return _agentVersion;
}

/**
 * prompt() 单轮内最大 LLM ↔ tool 往返次数。INVOX_MAX_ITERATIONS env 覆盖；
 * 非数字 / ≤ 0 走默认 50。
 */
export function maxIterations(): number {
  const raw = process.env["INVOX_MAX_ITERATIONS"];
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}
