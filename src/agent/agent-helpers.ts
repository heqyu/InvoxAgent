// agent.ts 抽出的杂项 helper —— 不依赖 LLM / 协议 / 工具子系统。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _agentVersion: string | undefined;

/**
 * 读取 invox 自身 package.json 的 version 字段（用于 hook context、
 * MCP client identity 等诊断字段）。失败永远返回 "unknown"，不抛错。
 *
 * 路径上溯两级：
 *   dev:  <root>/src/agent/agent-helpers.ts → __dirname=<root>/src/agent/ → ../../
 *   dist: <root>/dist/agent/agent-helpers.js → __dirname=<root>/dist/agent/ → ../../
 * 两边都命中 <root>/package.json。
 *
 * （旧实现只跳一级到 src/ 或 dist/，永远 ENOENT；K12 修复见 PROGRESS.md）
 */
export function agentVersion(): string {
  if (!_agentVersion) {
    try {
      const p = join(__dirname, "..", "..", "package.json");
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
 * prompt() 单轮内最大 LLM ↔ tool 往返次数。
 * INVOX_MAX_ITERATIONS env 覆盖；非数字 / ≤ 0 一律走默认 150。
 */
export function maxIterations(): number {
  const raw = process.env["INVOX_MAX_ITERATIONS"];
  if (!raw) return 150;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 150;
  return n;
}
