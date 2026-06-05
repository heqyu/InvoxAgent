// Glob 工具：按 glob 模式找文件，按 mtime 倒序返回。
//
// 用 fast-glob，纯 JS 实现，免外部二进制。默认搜索根是会话 cwd；
// 默认尊重 .gitignore，并屏蔽 node_modules / .git / dist / build。
//
// 设计选择：按 mtime 倒序排（最新的在前），与 Claude Code glob 一致 ——
// 最近修改的文件通常更相关。

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import fg from "fast-glob";
import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const DEFAULT_LIMIT = 200;

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Glob",
    description:
      "Find files matching a glob pattern. Returns absolute paths sorted " +
      "by modification time, newest first. Use this to discover files in " +
      "a project (e.g. '**/*.ts' for all TypeScript, 'src/**/*.tsx' for " +
      "TSX under src). Honors .gitignore by default. Default limit 200; " +
      "increase via the limit arg if you need more.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern such as '**/*.ts' or 'src/**/components/*.tsx'. " +
            "Brace expansion supported: '**/*.{ts,tsx}'.",
        },
        path: {
          type: "string",
          description:
            "Optional directory to search in (absolute or relative to " +
            "session cwd). Defaults to the session cwd.",
        },
        limit: {
          type: "integer",
          description: `Max paths to return. Default ${DEFAULT_LIMIT}.`,
        },
      },
      required: ["pattern"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const pattern = String(args["pattern"] ?? "");
  if (!pattern) return errorResult("missing 'pattern'", "other", "Glob");

  const rawPath = typeof args["path"] === "string" ? args["path"] : "";
  const searchRoot = rawPath ? resolve(ctx.cwd, rawPath) : ctx.cwd;

  const limit =
    typeof args["limit"] === "number" && args["limit"] > 0
      ? Math.floor(args["limit"])
      : DEFAULT_LIMIT;

  log.info("tool: Glob", { pattern, searchRoot, limit });

  let entries: string[];
  try {
    entries = await fg(pattern, {
      cwd: searchRoot,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      // 屏蔽噪声 / 大目录 —— node_modules 不屏蔽会拖死任何非 trivial 仓库
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
    });
  } catch (e) {
    return errorResult(
      `glob failed: ${(e as Error).message}`,
      "other",
      `Glob: ${pattern}`,
    );
  }

  // 按 mtime 倒序排。本地 FS 上 statSync 批量很快；超大集合用 STAT_CAP 防爆。
  const STAT_CAP = 2000;
  const toSort = entries.slice(0, STAT_CAP);
  const withMtime = toSort.map((p) => {
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      // 不可 stat 的项忽略
    }
    return { p, mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const truncated = entries.length > limit;
  const top = withMtime.slice(0, limit).map((e) => normalizePath(e.p));

  const header =
    `Pattern: ${pattern}` +
    (rawPath ? `\nPath: ${searchRoot}` : "") +
    `\nMatched: ${entries.length}` +
    (truncated
      ? ` (showing first ${limit} by mtime; pass higher \`limit\` to see more)`
      : "") +
    `\n`;
  const body = top.length > 0 ? top.join("\n") : "(no matches)";
  const display = header + body;

  return {
    resultText: display,
    acpContent: [{ type: "content", content: { type: "text", text: display } }],
    kind: "other",
    title: titleFor(pattern),
    ok: true,
  };
}

function normalizePath(p: string): string {
  // fast-glob 在 absolute:true 时即使 Windows 也返 posix 风格路径。
  // Zed 的 chip 检测和用户复制粘贴都偏好原生分隔符，此处转一道。
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

function titleFor(pattern: string): string {
  return `Glob ${pattern}`;
}

export const globTool: Tool = {
  name: "Glob",
  tier: "read",
  spec,
  execute,
};
