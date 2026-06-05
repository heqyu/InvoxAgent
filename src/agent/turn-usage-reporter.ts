// 每个 prompt() turn 结束时上报 token 用量。
//
// 兼容性双通道（与 PROGRESS / CLAUDE.md 一致）：
//
//   1. `usage_update` —— ACP 0.13+ `unstable_session_usage` 特性的官方变种。
//      Zed 在 `acp-beta` 开关开启时把它渲染成 model 下拉旁边的小芯片。
//      schema：`{ sessionUpdate: "usage_update", used, size }`。
//
//   2. `agent_thought_chunk`（带 `_meta.invox/usage`）—— 兜底渲染。
//      Zed 把它折叠到 "Thinking" 块里，即便 acp-beta 关着用户也能看到计数。
//
// provider 没有 yield usage（如 EchoProvider）时两条都跳过 —— 让 Echo /
// 自托管不支持 stream_options.include_usage 的 backend 安静失败而非报零。
//
// 函数会写入 session.lastTurnUsage —— 唯一的副作用，与文件名 "reporter"
// 含义一致；命名约定不阻拦。

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Session } from "./session-types.js";
import { contextWindowFor, humanizeTokens } from "./token-meter.js";

/**
 * 上报本 turn 的 token usage 并把摘要写入 session.lastTurnUsage。
 *
 * @param session     当前会话
 * @param stopReason  本 turn 的终止原因（end_turn / cancelled / max_turn_requests / refusal）
 * @param conn        ACP 连接
 * @param defaultModelId  session 未选中 model 时的兜底
 */
export async function reportTurnUsage(
  session: Session,
  stopReason: "end_turn" | "cancelled" | "max_turn_requests" | "refusal",
  conn: AgentSideConnection,
  defaultModelId: string,
): Promise<void> {
  const u = session.turnUsage;
  if (u.calls === 0) return;
  const model = session.selectedModel ?? defaultModelId;
  const partial = stopReason !== "end_turn";

  // 1. 官方 usage_update（受 Zed acp-beta 控制）
  const contextWindow = contextWindowFor(model);
  // 用 maxPrompt 作为 context 占用 —— 每次 LLM 调用都 resend 完整 history，
  // SUM(prompt_tokens) 是 billing 维度，不是 context 占用维度。
  const used = u.maxPrompt + u.output;
  await conn.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "usage_update",
      used,
      size: contextWindow,
    },
  });

  // 2. 算本 turn 耗时
  const elapsedMs =
    session.turnStartedAt > 0 ? Date.now() - session.turnStartedAt : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // 3. 兜底通道：agent_thought_chunk + _meta 扩展
  const ctxFmt = humanizeTokens(used);
  const sizeFmt = humanizeTokens(contextWindow);
  // 显示最大 context 那一次的 cache 命中率。maxCached 与 maxPrompt 保证
  // 来自同一调用（accumulateTurnUsage 中对齐），比例有意义。
  const cacheHint =
    u.maxCached > 0 && u.maxPrompt > 0
      ? ` · cache ${Math.round((u.maxCached / u.maxPrompt) * 100)}%`
      : "";
  const text =
    `🪙 Context: ${ctxFmt} / ${sizeFmt}` +
    ` · ${u.calls} turns · ${elapsedSec}s` +
    cacheHint +
    (partial ? ` · ${stopReason}` : "") +
    ` · ${model}`;
  await conn.sessionUpdate({
    sessionId: session.id,
    _meta: {
      "invox/usage": {
        turn: {
          input: u.input,
          output: u.output,
          total: u.total,
          calls: u.calls,
          maxPrompt: u.maxPrompt,
          maxCached: u.maxCached,
          cached: u.cached,
        },
        model,
        contextWindow,
        stopReason,
      },
    },
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
  });

  // 4. 持久化 lastTurnUsage 供重启后展示
  session.lastTurnUsage = {
    input: u.input,
    output: u.output,
    total: u.total,
    calls: u.calls,
    maxPrompt: u.maxPrompt,
    maxCached: u.maxCached,
    cached: u.cached,
    elapsedMs,
    model,
  };
}
