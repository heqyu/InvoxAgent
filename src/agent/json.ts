// JSON 解析 helper —— 服务于 LLM tool_call 参数的容错。
//
// 设计要点：
//   - safeParseJSON：通用版，解析失败返回 null（不抛错），用于非关键路径
//     （标题渲染、日志预览等）
//   - parseToolArguments：tool_call 参数专用，区分三种情况：
//       1. 空字符串 / 仅空白 → ok（视为无参数 → {}）
//       2. 合法 JSON object  → ok
//       3. 其它              → err，附错误描述。caller 必须把错误回灌
//          给 LLM 作为 tool result，让模型自行纠错（畸形 JSON 偶尔会
//          带 trailing comma / 截断 / Markdown 包裹）
//
// 设计选择：拒绝把数组 / 字符串 / 数字 / null / 布尔当 tool args ——
// OpenAI / Claude tool calling 协议规定 function.arguments 必须是 JSON
// object 字符串，非 object 视为 LLM 错误。

/**
 * 安全 JSON.parse —— 仅当结果是 plain object 时返回；
 * 解析失败 / 顶层是数组或标量，一律返回 null。
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
 * 解析 LLM tool_call 的 `arguments`（协议规定它是 JSON object 字符串）。
 *
 * 返回 discriminated union：
 *   - `{ ok: true, value }`  —— 解析成功（含空字符串 → `{}`）
 *   - `{ ok: false, error }` —— 解析失败，error 文案给 LLM 看
 *
 * caller 在 ok=false 时应当：
 *   1. emit `tool_call_update` 状态为 failed
 *   2. push role:"tool" 到 history，content = error 文本
 *   3. continue 下一个 tool_call —— **不要抛异常**，否则整个 prompt loop
 *      死掉，用户看到的是"agent 卡住了"。
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
    // preview 截断到 200 字符，避免错误信息塞满 LLM 上下文
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
