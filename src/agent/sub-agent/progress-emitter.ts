// 进度回流（实时更新父 SubAgent 工具卡的 content）。
//
// 每当 wrapped conn 拦截到一条 inner `tool_call` 通知，就抽出 title 字段
// 追加一行 `▸ <Title>` 到内部 lines 列表。
//
// 每次追加都立刻通过**未经 wrap 的原 conn** 发一条 `tool_call_update`，
// toolCallId = 父 SubAgent tool_call 的 id；只更新 `content` 字段。
//
// lines[0] 永远是 `Log: <path>` —— 用户能从 UI 卡片直接看到独立日志位置。

import type { AgentSideConnection } from "@agentclientprotocol/sdk";

export interface ProgressEmitter {
  recordInnerToolCall(title: string): void;
  /** 把 final 的 progressLines（含 Log 行 + 所有 ▸ 行）暴露给 caller。 */
  lines(): readonly string[];
}

export function makeProgressEmitter(
  conn: AgentSideConnection,
  sessionId: string,
  parentToolCallId: string,
  logPath: string | undefined,
): ProgressEmitter {
  const lines: string[] = [];
  if (logPath) lines.push(`Log: ${logPath}`);
  lines.push("▸ subagent started");

  // 起手立刻发一帧 card update，让用户立即看到日志路径 + "started" 行
  void emitCardUpdate();

  function renderCard(): string {
    // 进度行用 markdown 强换行（行尾两空格 + \n）让 Zed 真的一行一行渲染。
    return lines.join("  \n");
  }

  async function emitCardUpdate(): Promise<void> {
    try {
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: parentToolCallId,
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: renderCard() },
            },
          ],
        },
      });
    } catch {
      // 进度回流失败吞掉 —— 主流程不挂
    }
  }

  return {
    recordInnerToolCall: (title: string) => {
      lines.push(`▸ ${title}`);
      void emitCardUpdate();
    },
    lines: () => lines.slice(),
  };
}
