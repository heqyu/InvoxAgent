// loadSession 历史重放 —— 把磁盘上 Session.history 里的消息逐条以
// session/update 通知形式发给客户端，让 UI 在重新打开线程时恢复出
// 用户消息 / 助手消息 / 工具调用卡片。
//
// 设计点：
//   - 仅做 UI 重建，绝不重新执行工具
//   - role==="tool" 的消息会通过其 tool_call_id 索引回 assistant 那一条
//     的 tool_calls[i]，渲染成完整的"调用 + 结果"卡片
//   - system 消息不重放（客户端不显示 system message）
//   - 不修改 session 状态
//
// 抽出原因：A2 拆分；agent.ts 减重，让 InvoxAgent 类只剩 ACP 入口与状态。

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { LLMMessage } from "../llm/types.js";
import { contentToString } from "../llm/utils.js";
import { kindFromTier } from "../tools/permissions.js";
import { getTool } from "../tools/registry.js";
import { safeParseJSON } from "./json.js";
import type { Session } from "./session-types.js";
import { startLocationsFor, startTitleFor } from "./tool-presentation.js";

/**
 * 把 session.history 重放给客户端 UI。仅 user / assistant 角色会发出
 * 通知；tool 结果通过 assistant.tool_calls 关联的方式拼回完整卡片。
 */
export async function replayHistory(
  session: Session,
  conn: AgentSideConnection,
): Promise<void> {
  // 先建 tool_call_id → tool message 索引，避免内层循环 O(n)。
  const toolResultById = new Map<string, LLMMessage>();
  for (const m of session.history) {
    if (m.role === "tool" && m.tool_call_id) {
      toolResultById.set(m.tool_call_id, m);
    }
  }

  for (const m of session.history) {
    if (m.role === "user") {
      await conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: contentToString(m.content) },
        },
      });
      continue;
    }

    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.length > 0) {
        await conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }
      for (const call of m.tool_calls ?? []) {
        const tool = getTool(call.name);
        const replayLocations = startLocationsFor(call);
        await conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: startTitleFor(call),
            kind: tool ? kindFromTier(tool.tier) : "other",
            status: "in_progress",
            rawInput: safeParseJSON(call.arguments) ?? {
              raw: call.arguments,
            },
            ...(replayLocations ? { locations: replayLocations } : {}),
          },
        });
        const result = toolResultById.get(call.id);
        const resultText = result
          ? typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content)
          : "(no recorded result)";
        await conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: "completed",
            title: startTitleFor(call),
            kind: tool ? kindFromTier(tool.tier) : "other",
            content: [
              {
                type: "content",
                content: { type: "text", text: resultText },
              },
            ],
            ...(replayLocations ? { locations: replayLocations } : {}),
          },
        });
      }
      continue;
    }
    // system / tool 角色不主动重放（system 不展示；tool 已在 assistant 分支拼回）
  }
}
