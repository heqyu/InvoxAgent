// LLM provider 公用 helper —— 避免在 echo / mock / openai 之间复制粘贴。

import type { UserContent } from "./types.js";

/**
 * 把 UserContent（string 或 ChatCompletionContentPart[]）压成纯文本预览。
 * 用于日志、session 标题、mock provider 的 echo 等场景。
 *
 * 接受 undefined，调用方可直接传 `msg?.content`。
 */
export function contentToString(
  content: string | UserContent | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`))
    .join(" ");
}

/** 按固定大小切片字符串 —— mock / echo provider 用来模拟流式输出。 */
export function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Promise 风格的 setTimeout。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
