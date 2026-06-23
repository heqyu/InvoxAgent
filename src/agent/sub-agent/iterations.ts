// SubAgent 配置常量 + history 辅助函数。

import type { LLMMessage } from "../../llm/types.js";
import { maxIterations as parentMaxIterations } from "../agent-helpers.js";

// ── 配置常量 ──────────────────────────────────────────────────────────

/**
 * subagent 单次跑的最大迭代次数。比父 loop 默认 50 更紧 —— subagent 是
 * "委派子任务"，不应该耗光父 turn 的预算。
 */
const SUBAGENT_MAX_ITERATIONS_FALLBACK = 25;

/**
 * subagent 迭代上限：
 *   - INVOX_SUBAGENT_MAX_ITERATIONS env 显式指定时优先（≥1 的整数）
 *   - 否则取 min(父 loop 上限, SUBAGENT_MAX_ITERATIONS_FALLBACK)
 */
export function subAgentMaxIterations(): number {
  const raw = process.env["INVOX_SUBAGENT_MAX_ITERATIONS"];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.min(parentMaxIterations(), SUBAGENT_MAX_ITERATIONS_FALLBACK);
}

// ── History 辅助 ──────────────────────────────────────────────────────

/**
 * 取 history 末尾最后一条 assistant 文本消息。
 *
 * - subagent 收尾时 prompt-loop 会 push 一条 `{role:"assistant", content:string}`
 * - tool_calls 残留行（content 通常为空）也是 assistant，但其 content 大概率
 *   是空串；这里取"最后一条 string content"避免把 tool_calls 那条当成文本输出
 * - 找不到时返回空串，调用方负责给出兜底文案
 */
export function lastAssistantText(history: readonly LLMMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/**
 * 把 history 切片中所有 assistant 消息的 string content 串起来。
 *
 * 用途：iter 末尾把"本轮新增的 assistant 文本"合并成一行写日志，替代
 * per-token agent_message_chunk 的逐条记录。
 */
export function collectAssistantText(slice: readonly LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of slice) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content) {
      parts.push(m.content);
    }
  }
  return parts.join("\n");
}

// ── 时间戳 helper ─────────────────────────────────────────────────────

import { formatTimestamp } from "../../log.js";

/** 时间戳前缀（本地时间）—— 复用 log.ts 的 formatTimestamp。 */
export function ts(): string {
  return formatTimestamp(new Date());
}
