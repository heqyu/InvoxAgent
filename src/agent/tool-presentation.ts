// 工具调用呈现助手 —— LLM tool_call 在 ACP UI 上的渲染相关纯函数：
//   - previewArgs       —— 给日志看的参数预览（截断长字符串）
//   - startTitleFor     —— tool_call 通知卡片的标题；文件类工具刻意把路径
//                          放进标题，让 Zed 的 "Go to File" 能识别
//   - startLocationsFor —— tool_call 通知的 locations 字段，让客户端
//                          UI 在工具运行期间高亮目标文件
//
// 这些都是无副作用的纯渲染函数，依赖 safeParseJSON 安全解析 LLM 提供的
// 参数（畸形 JSON 时优雅降级）。

import type { ParsedToolCall } from "../llm/types.js";
import { safeParseJSON } from "./json.js";

/**
 * 把 tool 的 raw args 字符串渲染成日志预览。
 *
 * 策略：
 *   - 解析失败（畸形 JSON）→ 截断到 100 字符的原始字符串
 *   - 解析成功 → 把每个字符串字段截到 100 字符（带 "…(+N)" 长度标记）
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
 * 文件类工具（Read / Write / Edit）刻意忽略 LLM 自报的 description ——
 * 把文件路径放在标题里，让 Zed 的 "Go to File" 能正确识别点击目标。
 * description 仍会通过 tool result body 流给用户。
 *
 * Bash 用反引号包裹命令前 80 字符；Skill 显示 skill 名；其他非文件类工具
 * 回退到 LLM 提供的 description；都没有则用工具名兜底。
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
  // 非文件类工具回退到 LLM 提供的自由描述
  const desc =
    typeof parsed?.["description"] === "string"
      ? parsed["description"].trim()
      : "";
  if (desc) return desc;
  return call.name;
}

/**
 * 构造首次 tool_call 通知的 ACP `locations`，让 Zed 的 "Go to File"
 * 在工具仍在运行时就能亮起（而非等执行完再亮）。
 * 仅文件类工具在调用时刻就能拿到有意义的路径。
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
