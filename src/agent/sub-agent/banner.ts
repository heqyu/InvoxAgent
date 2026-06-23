// 退出 banner 文本（供 tools/sub-agent.ts 拼入工具卡 acpContent）。
//
// 从 agent_thought_chunk 迁移到工具卡 acpContent：当多个 SubAgent 并行完成
// 时，Zed 把所有 agent_thought_chunk 合并进同一个 "Thinking" 块，banner 互相
// 叠加不可读。放到各自工具卡的 completed content 里，天然分离且信息不丢。

import { preview } from "../../log.js";
import { humanizeTokens } from "../token-meter.js";
import type { SubAgentRunResult } from "./index.js";

/**
 * 构建 subagent 收尾 banner 纯文本。
 */
export function buildSubAgentBanner(opts: {
  subagentType: string;
  stopReason: SubAgentRunResult["stopReason"];
  iterations: number;
  elapsedMs: number;
  input: number;
  output: number;
  total: number;
  logPath?: string;
  error?: string;
}): string {
  const elapsedSec = (opts.elapsedMs / 1000).toFixed(1);
  const lines: string[] = [
    `🤖 SubAgent ${opts.subagentType} · ${opts.iterations} iter · ${elapsedSec}s · stop=${opts.stopReason}`,
    `🪙 in ${humanizeTokens(opts.input)} → out ${humanizeTokens(opts.output)} (${humanizeTokens(opts.total)} total)`,
  ];
  if (opts.error) {
    lines.push(`❌ ${preview(opts.error, 200)}`);
  }
  if (opts.logPath) {
    lines.push(`📁 ${opts.logPath}`);
  }
  // 两空格 + \n 强换行，让 Zed markdown 逐行渲染（单 \n 是 soft break）
  return lines.join("  \n");
}
