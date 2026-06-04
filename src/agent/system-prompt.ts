// 系统提示词与用户内容构建。
//
// 提供：
//   - DEFAULT_SYSTEM_PROMPT —— 默认系统提示词常量
//   - systemMessageWithMemoryAndSkills —— 拼装 system message
//     （prompt 主体 + Context + CLAUDE.md memory + skill catalog）
//   - THINKING_VALUES / thinkingToReasoningEffort —— 思考强度枚举与
//     OpenAI reasoning_effort 映射
//   - buildUserContent —— ACP ContentBlock[] → OpenAI UserContent 的转换
//
// 这些都是无副作用的纯渲染函数，独立可测。

import os from "node:os";
import type OpenAI from "openai";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { LLMMessage, UserContent } from "../llm/types.js";
import { discoverDirs } from "../discovery/index.js";
import { listAvailableCommands } from "../tools/skill.js";

// ── 默认系统提示词 ────────────────────────────────────────────────────

/**
 * 默认 system prompt 主体 —— 也作为 cli.ts 中 BUILTIN_SYSTEM_PROMPTS 的
 * "default" 条目。改动时同步看 cli.ts 的 prompt template 列表。
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

// ── system message 拼装 ──────────────────────────────────────────────

/**
 * 把 prompt body 拼装成完整 system message：
 *   1. 用户传入的 prompt 主体
 *   2. # Context（当前日期 + 平台 + cwd）
 *   3. # Memory（CLAUDE.md 的 user-level + project-level）
 *   4. # Skills（可用 skill 目录）
 *
 * 与 Claude Code "memory + skill" 注入语义对齐。无副作用，每次 newSession /
 * loadSession / setSessionConfigOption 都重新调用以拿到最新目录。
 */
export function systemMessageWithMemoryAndSkills(
  prompt: string,
  cwd: string,
): LLMMessage {
  let content = prompt;

  // 0. Context：日期 + 平台 —— 帮助 LLM 生成正确的 shell 命令
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const platform = process.platform; // "win32" | "darwin" | "linux"
  const arch = process.arch; // "x64" | "arm64" | ...
  const release = os.release(); // 如 "10.0.26100"
  content +=
    `\n\n# Context\n\n` +
    `Current date: ${dateStr}\n` +
    `Platform: ${platform} (${arch}), release ${release}\n` +
    `Working directory: ${cwd}`;

  // 1. Memory（来自 discovery 的所有 MemoryProvider —— 当前内置 CLAUDE.md，
  //    未来可加 session-notes / longterm / RAG 等。已按 priority 升序排好。）
  const memories = discoverDirs(cwd).memories;
  if (memories.length > 0) {
    const sections = memories
      .map((m) => {
        // 给一个稳定的小标题，便于 LLM 识别这一段的来源
        const label =
          m.provider === "claude-md"
            ? `CLAUDE.md [${m.source}]`
            : `${m.provider} [${m.source}]`;
        return `# ${label}\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    content += `\n\n# Memory\n\nThe following are project / user memories. Follow these instructions/preferences:\n\n${sections}`;
  }

  // 2. 可用 skill
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

// ── thinking / reasoning_effort ──────────────────────────────────────

/** thinking 配置允许的取值。必须与 configOptionsFor 暴露的 options 一致。 */
export const THINKING_VALUES = new Set(["off", "low", "medium", "high"]);

/**
 * 把面向用户的 thinking 值映射到 OpenAI SDK 的 reasoning_effort 枚举。
 * "off" → 不开启 reasoning（返回 undefined，wire 请求里省略该字段）；
 * "low" / "medium" / "high" 原样透传。
 */
export function thinkingToReasoningEffort(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "none" | undefined {
  if (!value || value === "off") return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

// ── prompt content builder ──────────────────────────────────────────

/**
 * 把 ACP ContentBlock[] 转成 OpenAI 兼容的 UserContent。
 *
 * 策略：
 *   - 收集所有 part 到 ChatCompletionContentPart 数组
 *   - 若结果只有一个 plain-text part，压成裸 string（日志更易读，也兼容
 *     不支持数组形式 content 的 provider）
 */
export function buildUserContent(blocks: ContentBlock[]): UserContent {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;

      case "resource_link": {
        // 仅告诉 LLM 文件被附带（按名 / 路径），不内联文件内容 ——
        // 让 LLM 决定是否调 Read 工具去读。
        const label = block.name ?? block.uri ?? "attached file";
        const path = uriToPath(block.uri);
        parts.push({
          type: "text",
          text: `[File: ${label}]${path ? ` (${path})` : ""}`,
        });
        break;
      }

      case "image": {
        // 内联 data URI 或直接透传 URI
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
        // 文本资源直接内联
        const txt = "text" in block.resource ? block.resource.text : undefined;
        if (txt) parts.push({ type: "text", text: txt });
        break;
      }

      default:
        // 未识别的 block 类型直接忽略
        break;
    }
  }

  // 单 text part → 压成裸字符串
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }

  return parts as OpenAI.Chat.Completions.ChatCompletionContentPart[];
}

/**
 * file:// URI → 本地路径：
 *   - file:///C:/foo  → C:/foo（Windows 盘符特殊处理）
 *   - file:///path    → /path
 *   - 非 file 协议    → 原样返回
 *   - 去掉 #fragment / ?query
 *
 * 模块内部使用，不导出。
 */
function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = uri.slice("file://".length);
  // Windows 盘符：/C:/... → C:/...
  if (p.length > 2 && p[0] === "/" && p[2] === ":") p = p.slice(1);
  // 去掉 fragment (#L10) 和 query (?symbol=...)
  const hash = p.indexOf("#");
  if (hash !== -1) p = p.slice(0, hash);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  return p;
}
