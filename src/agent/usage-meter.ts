// 每轮（per-prompt-turn）token 计费累加器。
//
// 设计要点：
//   - 仅就地修改 turnUsage，无其它副作用
//   - maxPrompt 与 maxCached 必须来自「同一次 LLM 调用」—— 否则 cache 命中率
//     与 context 占用比例失去意义；并列时取较大 maxCached
//   - 不做单位换算 / humanize —— 那是表达层（agent.ts: reportTurnUsage）
//
// 不变式：
//   - 调用 N 次后 turnUsage.calls === N
//   - turnUsage.input 是 N 次 input 之和（billing 维度，区别于 maxPrompt 这个
//     context 占用维度）
//   - turnUsage.maxPrompt = 所有调用 input 的 max
//   - turnUsage.maxCached 取自 maxPrompt 所在那一次（领带时取较大）

import type { UsageInfo } from "../llm/types.js";

/** 每轮 token 计费累加器结构 —— 与 Session.turnUsage 对齐。 */
export interface TurnUsage {
  /** 所有调用 prompt_tokens 之和（billing 维度）。 */
  input: number;
  /** 所有调用 completion_tokens 之和。 */
  output: number;
  /** total_tokens 累计（即 input + output，由上游报，可能略有偏差）。 */
  total: number;
  /** 本轮 LLM 调用次数。 */
  calls: number;
  /** prompt cache 命中 tokens 累计（所有调用之和）。 */
  cached: number;
  /** 单次调用 prompt_tokens 的最大值 —— 代表 context 占用峰值。
   *  每次调用都会把完整 history 重发，因此 SUM(input) ≠ context 占用，max 才是。 */
  maxPrompt: number;
  /** 与 maxPrompt 来自同一次调用的 cached tokens —— 领带时取较大值。 */
  maxCached: number;
}

/** 创建空 TurnUsage —— 在 prompt() 进入时调用。 */
export function emptyTurnUsage(): TurnUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    calls: 0,
    cached: 0,
    maxPrompt: 0,
    maxCached: 0,
  };
}

/**
 * 把一次 LLM 调用的 usage 合并进 TurnUsage。
 * 关键不变式见文件头。
 */
export function accumulateTurnUsage(
  turnUsage: TurnUsage,
  usage: UsageInfo,
): void {
  turnUsage.input += usage.input;
  turnUsage.output += usage.output;
  turnUsage.total += usage.total;
  turnUsage.calls += 1;
  turnUsage.cached += usage.cached;
  // maxPrompt 与 maxCached 必须配对，这样 maxCached/maxPrompt 才能反映
  // "最大那一次"的 cache 命中率。新最大值出现时把 maxCached 重置为该次；
  // 领带时取较大 maxCached（更乐观）。
  if (usage.input > turnUsage.maxPrompt) {
    turnUsage.maxPrompt = usage.input;
    turnUsage.maxCached = usage.cached;
  } else if (usage.input === turnUsage.maxPrompt) {
    turnUsage.maxCached = Math.max(turnUsage.maxCached, usage.cached);
  }
}
