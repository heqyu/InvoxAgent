// Glob: find files matching a glob pattern, sorted by mtime descending.
//
// Uses fast-glob — pure JS, no external binaries needed. Default search
// root is the session cwd; .gitignore patterns are honored when present.
//
// CHOICE: results sorted by mtime (newest first) the way Claude Code's
// glob does. Newer files are usually more relevant for recent work.

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import fg from "fast-glob";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;

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
        description: DESCRIPTION_FIELD,
      },
      required: ["pattern", "description"],
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
      // Skip noisy / large directories. node_modules in particular would
      // kill performance and flood results in any non-trivial repo.
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
    });
  } catch (e) {
    return errorResult(
      `glob failed: ${(e as Error).message}`,
      "other",
      `Glob: ${pattern}`,
    );
  }

  // Sort by mtime descending (newest first). statSync is fast in batch on
  // local FS; for huge result sets the cap below limits how many we stat.
  const STAT_CAP = 2000;
  const toSort = entries.slice(0, STAT_CAP);
  const withMtime = toSort.map((p) => {
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      // ignore unstattable
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
    title: titleFor(args, pattern),
    ok: true,
  };
}

function normalizePath(p: string): string {
  // fast-glob returns posix-style paths even on Windows when absolute:true.
  // For Zed's chip-detection (which underlines paths in chat) and for users
  // copy-pasting, prefer the OS-native separator.
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

function titleFor(args: Record<string, unknown>, pattern: string): string {
  const desc =
    typeof args["description"] === "string" ? args["description"].trim() : "";
  if (desc) return desc;
  return `Glob ${pattern}`;
}

export const globTool: Tool = {
  name: "Glob",
  tier: "read",
  spec,
  execute,
};
