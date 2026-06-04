// JSON 解析助手 —— 服务于 LLM tool_call 参数的容错。
//
// PROGRESS A3 / K5：消除 agent.ts 里的裸 `JSON.parse(call.arguments)`。
//
// 设计要点：
//   - safeParseJSON：通用 helper，解析失败返回 null（不抛错），用于
//     非关键路径（标题渲染、日志预览等）
//   - parseToolArguments：tool_call 参数专用，区分三种语义：
//       1. 空字符串 / 仅空白 → ok（tool 无参数，返回 {}）
//       2. 合法对象 → ok
//       3. 非法 JSON → err，附带错误描述。caller 必须把错误回灌给 LLM
//          作为 tool result，让模型自我纠错（LLM 的 tool_calls 偶尔吐
//          trailing comma / 截断 JSON / Markdown 代码块包裹）
//
// CHOICE: 拒绝把非对象（数组、字符串、数字、null、布尔）当成 tool args。
//   OpenAI/Claude tool calling 协议规定 `function.arguments` 必须是 JSON
//   object 字符串。非对象 → 视为 LLM 错误。

/**
 * 安全 JSON.parse —— 仅当结果是 plain object 时返回，其他情况（解析失败、
 * 顶层是数组/标量）一律返回 null。
 */
export function safeParseJSON(s: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * 解析 LLM tool_call 的 `arguments` 字符串（OpenAI/Claude 协议规定它是
 * JSON object 字符串）。
 *
 * 返回 discriminated union：
 *   - `{ ok: true, value }` —— 解析成功（含空字符串 / 仅空白 → `{}`）
 *   - `{ ok: false, error }` —— 解析失败，error 是给 LLM 看的错误描述
 *
 * caller 应在 ok=false 时：
 *   1. emit `tool_call_update` with status="failed"
 *   2. push `role: "tool"` message 到 history，content = error 文本
 *   3. continue 到下一个 tool_call —— **不要抛出异常**，否则整个 prompt
 *      loop 死掉，用户看到的是"agent 卡住了"。
 */
export type ToolArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseToolArguments(rawArgs: string): ToolArgsResult {
  const trimmed = rawArgs.trim();
  if (trimmed === "") return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // preview：截断到 200 字符，避免错误信息塞满 LLM 上下文
    const preview =
      trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
    return {
      ok: false,
      error: `Tool arguments are not valid JSON: ${msg}. Received: ${preview}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      error: `Tool arguments must be a JSON object, got ${kind}.`,
    };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
