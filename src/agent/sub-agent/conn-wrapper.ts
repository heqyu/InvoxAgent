// 给 subagent 用的 conn 包装层。
//
// 转发规则：
//   - 所有 sessionUpdate **完全静默**，不再向父 UI 转发；改为按时间序写到
//     subagent 自己的日志文件
//   - 但当 progress emitter 注入时，inner `tool_call` 通知会被旁路到 emitter
//   - 非 sessionUpdate 方法原样转发到原 conn
//
// 设计取舍：用 Proxy 而非新 class —— ACP SDK 的 AgentSideConnection 接口很宽，
// Proxy 转发能自动覆盖未来新增的协议入口。

import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { preview, type LogFile } from "../../log.js";
import { ts } from "./iterations.js";
import type { ProgressEmitter } from "./progress-emitter.js";

/**
 * 抽出一条 SessionNotification 的可读摘要，写到 subagent 日志文件。
 *
 * 设计点：
 *   - 每条 update 一行，便于 grep "tool_call" 之类
 *   - 截短长字段（content / title），保留事件结构信息为主
 *   - 不识别的 sessionUpdate kind 直接 JSON 化前 200 字符（forward-compat）
 *
 * 注意：调用前应先用 shouldLogNotif 过滤掉 chunk / 中间态等噪音事件。
 */
export function summarizeNotif(n: SessionNotification): string {
  const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
  const kind = u.sessionUpdate;
  switch (kind) {
    case "tool_call": {
      const id = u["toolCallId"];
      const title = u["title"];
      const k = u["kind"];
      return `tool_call id=${id} kind=${k} title="${preview(String(title ?? ""), 120)}"`;
    }
    case "tool_call_update": {
      const id = u["toolCallId"];
      const status = u["status"];
      const title = u["title"];
      return `tool_call_update id=${id} status=${status} title="${preview(String(title ?? ""), 120)}"`;
    }
    default: {
      const j = JSON.stringify(u);
      return `${kind} ${preview(j, 200)}`;
    }
  }
}

/**
 * 决定一条 SessionNotification 是否值得写到 subagent 独立日志。
 *
 * 噪音过滤策略（实测：典型 12 iter subagent 共 1531 条 notif，过滤后剩 ~80）：
 *
 *   - **agent_message_chunk / agent_thought_chunk**：丢
 *   - **tool_call_update with status="in_progress"**：丢
 *   - **usage_update**：丢
 *   - **plan / available_commands_update**：丢
 *   - **tool_call（启动）+ 终态 tool_call_update**：保留
 *   - **未识别 kind**：保留 —— forward-compat
 */
export function shouldLogNotif(n: SessionNotification): boolean {
  const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    return false;
  }
  if (kind === "usage_update") return false;
  if (kind === "plan" || kind === "available_commands_update") return false;
  if (kind === "tool_call_update") {
    const status = u["status"];
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }
  return true;
}

/**
 * 给 subagent 用的 conn 包装层。
 *
 * 设计取舍：用 Proxy 而非新 class —— ACP SDK 的 AgentSideConnection 接口很宽，
 * Proxy 转发能自动覆盖未来新增的协议入口，避免每升一次 SDK 就漏一个。
 */
export function wrapConnForSubAgent(
  conn: AgentSideConnection,
  logFile: LogFile,
  progress: ProgressEmitter | undefined,
): AgentSideConnection {
  return new Proxy(conn, {
    get(target, prop, _receiver) {
      if (prop === "sessionUpdate") {
        return async (notif: SessionNotification): Promise<void> => {
          if (shouldLogNotif(notif)) {
            logFile.write(`${ts()}   ${summarizeNotif(notif)}`);
          }
          if (progress) {
            const u = notif.update as { sessionUpdate: string } & Record<
              string,
              unknown
            >;
            if (u.sessionUpdate === "tool_call") {
              const title =
                typeof u["title"] === "string" ? u["title"] : "(no title)";
              progress.recordInnerToolCall(title);
            }
          }
          return;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v === "function") {
        return (v as (...args: unknown[]) => unknown).bind(target);
      }
      return v;
    },
  }) as AgentSideConnection;
}
