// Tool call 渲染助手 —— Phase A2.2 拆分
//
// 从 agent.ts 抽出 LLM tool_call 在 ACP UI 上的呈现相关纯函数：
//   - previewArgs —— 给日志用的参数预览（截断长字符串）
//   - startTitleFor —— tool_call 通知卡片的标题（针对 file-touching 工具
//     特殊处理路径，让 Zed 的 "Go to File" 能识别）
//   - startLocationsFor —— tool_call 通知的 locations 字段，用于让客户端
//     UI 在工具运行期间高亮目标文件
//
// 这些都是无副作用的纯渲染函数；它们都依赖 safeParseJSON 来安全解析 LLM
// 提供的 tool args（畸形 JSON 时优雅降级到 fallback 文案）。

import type { ParsedToolCall } from "../llm/types.js";
import { safeParseJSON } from "./json.js";

/**
 * 把 tool 的 raw args 字符串渲染成给日志看的预览。
 *
 * 策略：
 *   - 解析失败（畸形 JSON）→ 截断到 100 字符的原始字符串
 *   - 解析成功 → 把每个字符串字段截到 100 字符（"…(+N)" 标记后续字节数）
 *
 * 这是 INVOX_LOG=info / debug 级别下的可读性优化，不影响行为。
 */
export function previewArgs(rawArgs: string): unknown {
  const parsed = safeParseJSON(rawArgs);
  if (!parsed) {
    return rawArgs.length > 100 ? rawArgs.slice(0, 100) + "…" : rawArgs;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 100) {
      out[k] = v.slice(0, 100) + `…(+${v.length - 100})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 为 tool_call 通知卡片选一个标题。
 *
 * 文件类工具（Read/Write/Edit）刻意忽略 LLM 自报的 description —— 我们把
 * 文件路径放在标题里，让 Zed 的 "Go to File" affordance 能正确识别点击
 * 目标。description 仍然会通过 tool result body 流给用户。
 *
 * Bash 用反引号包裹命令前 80 字符。Skill 显示 skill 名。其余非文件类
 * 工具回退到 LLM 提供的 description；都没有则用工具名兜底。
 */
export function startTitleFor(call: ParsedToolCall): string {
  const parsed = safeParseJSON(call.arguments);
  if (parsed) {
    switch (call.name) {
      case "Read": {
        const p = String(parsed["path"] ?? "");
        const offset = parsed["offset"];
        return p
          ? offset
            ? `Read ${p} (lines ${String(offset)}+)`
            : `Read ${p}`
          : "Read file";
      }
      case "Write": {
        const p = String(parsed["path"] ?? "");
        return p ? `Write ${p}` : "Write file";
      }
      case "Edit": {
        const p = String(parsed["path"] ?? "");
        return p ? `Edit ${p}` : "Edit file";
      }
      case "Bash": {
        const c = String(parsed["command"] ?? "");
        return c
          ? `\`${c.slice(0, 80)}${c.length > 80 ? "…" : ""}\``
          : "Run command";
      }
      case "Skill": {
        const n = String(parsed["name"] ?? "");
        return n ? `Skill: ${n}` : "Run skill";
      }
    }
  }
  // Non-file tools fall back to the LLM's free-form description.
  const desc =
    typeof parsed?.["description"] === "string"
      ? parsed["description"].trim()
      : "";
  if (desc) return desc;
  return call.name;
}

/**
 * Build ACP `locations` for the initial tool_call notification, so Zed's
 * "Go to File" / follow-along UI lights up while the tool is still
 * running (not just after completion). Only the file-touching tools
 * have a meaningful path at call-time.
 */
export function startLocationsFor(
  call: ParsedToolCall,
): { path: string }[] | undefined {
  const parsed = safeParseJSON(call.arguments);
  if (!parsed) return undefined;
  if (call.name === "Read" || call.name === "Write" || call.name === "Edit") {
    const p = typeof parsed["path"] === "string" ? parsed["path"].trim() : "";
    if (p) return [{ path: p }];
  }
  return undefined;
}
