import type { ToolSpec } from "../../llm/types.js";
import { createLogger } from "../../log.js";
const log = createLogger("templates");
import type { AgentTemplate } from "./types.js";

// ── 工具白名单过滤 ────────────────────────────────────────────────────

/**
 * 按 agent.tools 过滤内置工具规范列表。
 *
 * 语法（在同一数组里混用合法）：
 *   undefined / ["*"]            → 全部内置工具
 *   []                           → 禁用全部内置工具
 *   ["Read","Glob"]              → 严格白名单
 *   ["-Bash"] / ["*","-Bash"]    → 在全集中减去（任意 "-X" 出现就视为
 *                                   "全集减法"模式，不要求显式 "*"）
 *   ["Read","-Edit"]             → 同时含正项与负项 → 警告，按"全集减法"处理
 *
 * 工具名严格匹配（PascalCase）；mismatch 仅 warn 跳过。
 *
 * 返回原 specs 的子集（不修改原数组）。
 */
export function filterToolSpecsByAgent(
  specs: readonly ToolSpec[],
  allow: string[] | undefined,
): ToolSpec[] {
  // case 1：未设 = 全部
  if (allow === undefined) return [...specs];

  // case 2：显式空数组 = 全禁
  if (allow.length === 0) return [];

  const allNames = new Set(specs.map((s) => s.function.name));

  // 区分正项 / 负项
  const positives: string[] = [];
  const negatives: string[] = [];
  let hasStar = false;
  for (const t of allow) {
    if (t === "*") {
      hasStar = true;
    } else if (t.startsWith("-")) {
      negatives.push(t.slice(1));
    } else {
      positives.push(t);
    }
  }

  // 校验：未知工具名 warn 跳过（不影响其它）
  for (const p of positives) {
    if (!allNames.has(p)) {
      log.warn("agent tool whitelist: unknown tool", { name: p });
    }
  }
  for (const n of negatives) {
    if (!allNames.has(n)) {
      log.warn("agent tool blacklist: unknown tool", { name: n });
    }
  }

  // 含负项 → 全集减法模式（即便用户没写 "*"）
  // 同时含正项 + 负项时也按减法处理，并 warn 提示语义混合
  if (negatives.length > 0) {
    if (positives.length > 0) {
      log.warn(
        "agent tools: mixing positive and negative entries; treating as full-set subtraction",
        { positives, negatives },
      );
    }
    const denied = new Set(negatives);
    return specs.filter((s) => !denied.has(s.function.name));
  }

  // 只有 "*"（无负项无正项）→ 全集
  if (hasStar && positives.length === 0) return [...specs];

  // 只有正项 → 严格白名单
  const allowed = new Set(positives);
  // "*" 与正项并存：意为全集 ∪ 正项 —— 等同全集
  if (hasStar) return [...specs];
  return specs.filter((s) => allowed.has(s.function.name));
}

/**
 * agent 是否允许暴露 MCP 工具给 LLM。默认 true（不限制）。
 *
 * 注意：此处仅过滤"暴露给 LLM 的 toolSpecs"。MCP 子进程的 acquire/release
 * 仍按 cwd 共享池逻辑做（mcp-lifecycle.ts），未受影响 —— agent 切换时不会
 * 触发 MCP 进程重启。
 */
export function agentAllowsMcp(agent: AgentTemplate | undefined): boolean {
  if (!agent) return true;
  return agent.mcp !== false;
}
