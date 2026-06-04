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
 * 已知缺陷：路径解析在 dev/dist 两种模式下都指不到真实文件，函数实际
 * 一直返回 "unknown"。当前调用点只把它作为诊断字段，影响可忽略，
 * 留作 backlog 待修。
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
 * prompt() 单轮内最大 LLM ↔ tool 往返次数。
 * INVOX_MAX_ITERATIONS env 覆盖；非数字 / ≤ 0 一律走默认 50。
 */
export function maxIterations(): number {
  const raw = process.env["INVOX_MAX_ITERATIONS"];
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}
