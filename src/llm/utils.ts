// Shared helpers for LLM provider modules.
//
// Deduplicates contentToString (UserContent → preview string), chunkString,
// and sleep that were previously copy-pasted across echo.ts and mock-tools.ts.

import type { UserContent } from "./types.js";

/**
 * Convert a `UserContent` (string or ChatCompletionContentPart[]) into a
 * plain-text preview. Used for logging, persistence title extraction, and
 * mock provider echo.
 *
 * Accepts `undefined` so callers can pass `msg?.content` directly.
 */
export function contentToString(
  content: string | UserContent | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  // Walk the array without naming the OpenAI namespace.
  return (content as Array<{ type: string; text?: string }>)
    .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`))
    .join(" ");
}

/**
 * Split a string into fixed-size chunks. Used by mock/echo providers to
 * simulate streaming.
 */
export function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Promise-based setTimeout wrapper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
