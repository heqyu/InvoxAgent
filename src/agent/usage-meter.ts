// 每轮（per-prompt-turn）token 计费累加器 —— Phase A1 prep / A2 拆分预热。
//
// 从 agent.ts 中抽出来的纯函数版本，目的是：
//   1. 单测能直接 import 并断言累计语义（PROGRESS A1 硬指标）
//   2. 为 Phase A2「拆分 agent.ts」铺路（usage-meter 是计划中的 7 个子模块之一）
//
// 设计要点：
//   - 完全无副作用以外的耦合：只读 usage、就地写 turnUsage
//   - maxPrompt 与 maxCached 必须来自「同一次 LLM 调用」—— 否则 cache 命中率
//     与 context 占用比例失去意义；并列时取较优 maxCached
//   - 不做单位换算 / humanize —— 那是表达层（agent.ts 里的 reportTurnUsage）
//
// 不变式（invariants）：
//   - 调用 N 次后 turnUsage.calls === N
//   - turnUsage.input 是 N 次 input 之和（所有调用 prompt_tokens 累计 —— 这是
//     billing 维度，区别于 maxPrompt 这个 context 占用维度）
//   - turnUsage.maxPrompt = max over all calls 的 input
//   - 调用 maxCached 取自 maxPrompt 所在那一次（领带时取较大）

import type { UsageInfo } from "../llm/types.js";

/** 每轮 token 计费累加器结构 —— 与 Session.turnUsage 对齐。 */
export interface TurnUsage {
  /** 所有 LLM 调用 prompt_tokens 之和（billing 维度）。 */
  input: number;
  /** 所有 LLM 调用 completion_tokens 之和。 */
  output: number;
  /** total_tokens 累计（即 input + output，由上游报，可能略有偏差）。 */
  total: number;
  /** 本轮 LLM 调用次数。 */
  calls: number;
  /** prompt cache 命中 tokens 累计（所有调用之和）。 */
  cached: number;
  /** 单次调用 prompt_tokens 的最大值 —— 代表实际 context 占用的峰值。
   *  每次调用都会把完整 history 重发给 LLM，因此 SUM(input) 不等于 context
   *  占用，max 才是。 */
  maxPrompt: number;
  /** 与 maxPrompt 来自同一次调用的 cached tokens —— 领带时取较大值。 */
  maxCached: number;
}

/** 创建一个空的 TurnUsage —— 在 prompt() 进入时调用。 */
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
 * 把一次 LLM 调用的 usage 信息合并进 TurnUsage。
 *
 * 这是 PROGRESS A1 单测覆盖的核心 —— 关键不变式见文件头。
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
  // maxPrompt 与 maxCached 必须配对 —— 这样 maxCached/maxPrompt 才是「这次最
  // 大调用」的 cache 命中率。新最大值出现时把 maxCached 重置为这一次的 cached；
  // 领带时取较大 maxCached（更乐观）。
  if (usage.input > turnUsage.maxPrompt) {
    turnUsage.maxPrompt = usage.input;
    turnUsage.maxCached = usage.cached;
  } else if (usage.input === turnUsage.maxPrompt) {
    turnUsage.maxCached = Math.max(turnUsage.maxCached, usage.cached);
  }
}
