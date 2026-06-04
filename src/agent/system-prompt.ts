// 系统提示词与用户内容构建 —— Phase A2.1 拆分
//
// 从 agent.ts 抽出，包含：
//   - DEFAULT_SYSTEM_PROMPT —— 默认系统提示词常量
//   - systemMessageWithMemoryAndSkills —— 拼装 system message（含 CLAUDE.md
//     memory + skill catalog + 当前日期/平台 context）
//   - THINKING_VALUES / thinkingToReasoningEffort —— 思考强度枚举与
//     OpenAI reasoning_effort 映射
//   - buildUserContent —— ACP ContentBlock[] → OpenAI UserContent 的转换
//
// 依赖：
//   - LLMMessage / UserContent (../llm/types)
//   - ContentBlock (@agentclientprotocol/sdk)
//   - loadClaudeMd / listAvailableCommands —— discovery / skill 子系统
//
// 这些函数是无副作用的纯渲染，独立可测；后续 A2.x 拆分时被 prompt-loop /
// session-store 等多个模块复用。

import os from "node:os";
import type OpenAI from "openai";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { LLMMessage, UserContent } from "../llm/types.js";
import { loadClaudeMd } from "../discovery/claude-md.js";
import { listAvailableCommands } from "../tools/skill.js";

// ── 默认系统提示词 ────────────────────────────────────────────────────

/**
 * 默认 system prompt 主体 —— 由 cli.ts 拼装到 BUILTIN_SYSTEM_PROMPTS 的
 * "default" 条目。建议改动时同步看 cli.ts 的 prompt template 列表。
 */
export const DEFAULT_SYSTEM_PROMPT =
  `You are a helpful coding assistant embedded in Zed (a code editor).\n` +
  `\n` +
  `When the user sends a message you may receive multiple content blocks:\n` +
  `- text: plain user text\n` +
  `- resource_link (file): the user attached a file — use the Read tool to read it before answering\n` +
  `- image: the user attached an image — refer to it in your answer\n` +
  `\n` +
  `Always prefer using tools to answer questions about the codebase. ` +
  `If a file is referenced but not yet read, read it first.\n` +
  `\n` +
  `# Skills\n` +
  `\n` +
  `You have access to a Skill tool that loads reusable workflow templates from .claude/skills/. ` +
  `When the user asks you to use, run, load, or activate a skill — or when their message ` +
  `matches a known skill name — call the Skill tool to load and follow that skill's instructions.\n` +
  `Examples: "use skill /self-constrained-build", "run the review skill", "activate langgpt"\n` +
  `If unsure which skill to use, call Skill({ name: "list" }) to see all available skills.`;

// ── System message 拼装 ──────────────────────────────────────────────

/**
 * 把 prompt body 拼装成完整的 system message：
 *   1. 用户传入的 prompt 主体
 *   2. # Context 区块（当前日期 + 平台 + cwd）
 *   3. # Memory 区块（CLAUDE.md user-level + project-level）
 *   4. # Skills 区块（available skill catalog）
 *
 * 这与 Claude Code 的"memory + skill"注入语义对齐。无副作用，每次 newSession
 * / loadSession / setSessionConfigOption 都重新调用以拿到最新 catalog。
 */
export function systemMessageWithMemoryAndSkills(
  prompt: string,
  cwd: string,
): LLMMessage {
  let content = prompt;

  // 0. Context: date + platform (helps LLM generate correct shell commands)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const platform = process.platform; // "win32" | "darwin" | "linux"
  const arch = process.arch; // "x64" | "arm64" | ...
  const release = os.release(); // e.g. "10.0.26100"
  content +=
    `\n\n# Context\n\n` +
    `Current date: ${dateStr}\n` +
    `Platform: ${platform} (${arch}), release ${release}\n` +
    `Working directory: ${cwd}`;

  // 1. CLAUDE.md memory (user first, then project)
  const memory = loadClaudeMd(cwd);
  if (memory.length > 0) {
    const sections = memory
      .map((s) => `# CLAUDE.md [${s.source}]\n\n${s.content}`)
      .join("\n\n---\n\n");
    content += `\n\n# Memory\n\nThe following are from the user's CLAUDE.md files. Follow these instructions/preferences:\n\n${sections}`;
  }

  // 2. Available skills
  const commands = listAvailableCommands(cwd);
  if (commands.length > 0) {
    const lines = commands.map((c) => `- ${c.name}: ${c.description}`);
    content +=
      `\n\n# Skills\n\nThe following skills are available for use with the Skill tool:\n\n` +
      lines.join("\n") +
      `\n\nWhen the user types "/<skill-name>", invoke it via Skill. Only use skills listed above, don't guess.`;
  }

  return { role: "system", content };
}

// ── Thinking / reasoning_effort ──────────────────────────────────────

/** Allowed values for the `thinking` config option. Must match the
 *  options advertised in `configOptionsFor`. */
export const THINKING_VALUES = new Set(["off", "low", "medium", "high"]);

/**
 * Map the user-facing `thinking` value to the OpenAI SDK's
 * `reasoning_effort` enum. "off" means no reasoning at all (yields
 * undefined so the field is omitted from the request); the rest pass
 * through verbatim.
 */
export function thinkingToReasoningEffort(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "none" | undefined {
  if (!value || value === "off") return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

// ── Prompt content builder ──────────────────────────────────────────

/**
 * Convert ACP ContentBlocks into OpenAI-compatible `UserContent`.
 *
 * Strategy:
 *   - Collect all parts into an array of ChatCompletionContentPart.
 *   - If the result is a single plain-text part, collapse to a string
 *     (simpler for logs and for providers that don't support arrays).
 */
export function buildUserContent(blocks: ContentBlock[]): UserContent {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;

      case "resource_link": {
        // Tell the LLM which file was attached by name/path.
        // The actual file content is NOT inlined — the LLM should call Read tool.
        const label = block.name ?? block.uri ?? "attached file";
        const path = uriToPath(block.uri);
        parts.push({
          type: "text",
          text: `[File: ${label}]${path ? ` (${path})` : ""}`,
        });
        break;
      }

      case "image": {
        // Inline data URI or pass through the URI.
        const url =
          block.data && block.mimeType
            ? `data:${block.mimeType};base64,${block.data}`
            : (block.uri ?? "");
        if (url) {
          parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }

      case "resource": {
        // Inline text resource directly.
        const txt = "text" in block.resource ? block.resource.text : undefined;
        if (txt) parts.push({ type: "text", text: txt });
        break;
      }

      default:
        // Ignore unknown block types.
        break;
    }
  }

  // Collapse: single text part → plain string
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }

  return parts as OpenAI.Chat.Completions.ChatCompletionContentPart[];
}

/**
 * 把 file:// URI 转成本地路径。
 * - file:///C:/foo → C:/foo （Windows drive letter 处理）
 * - 普通 file:///path → /path
 * - 非 file 协议直接返回原 URI
 * - 去除 #fragment / ?query
 *
 * 该函数为模块内部使用（buildUserContent 用到），不导出。
 */
function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = uri.slice("file://".length);
  // Windows drive letter: /C:/... → C:/...
  if (p.length > 2 && p[0] === "/" && p[2] === ":") p = p.slice(1);
  // Strip fragment (#L10) and query (?symbol=...)
  const hash = p.indexOf("#");
  if (hash !== -1) p = p.slice(0, hash);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  return p;
}
