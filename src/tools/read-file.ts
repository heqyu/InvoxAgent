// Read 工具：行号化、分页读，带缓存。

import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { readFileWithCache, resolveToolPath } from "./fs-utils.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const TRUNCATED_LINE_SUFFIX = "… [truncated]";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Read",
    description:
      "Read a text file from the user's filesystem. Returns the file " +
      "contents prefixed with line numbers (cat -n style). Use offset+limit " +
      "to page through large files; the default cap is 2000 lines per call. " +
      "Single lines longer than 2000 chars are truncated. Empty files return " +
      "(File is empty). After Read you may call Edit on the same " +
      "path; without a prior Read the edit will be rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path, or path relative to session cwd.",
        },
        offset: {
          type: "integer",
          description:
            "1-based line number to start reading from. Optional; default 1.",
        },
        limit: {
          type: "integer",
          description: `Maximum lines to return. Optional; default ${DEFAULT_READ_LIMIT}.`,
        },
      },
      required: ["path"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  if (!rel) return errorResult("missing 'path'", "read", "Read");
  const path = resolveToolPath(ctx.cwd, rel);

  log.debug("Read: resolved path", { rel, resolved: path, cwd: ctx.cwd });

  const offset = isPositiveInt(args["offset"])
    ? Number(args["offset"])
    : undefined;
  const limit = isPositiveInt(args["limit"])
    ? Number(args["limit"])
    : undefined;
  const effectiveLimit = limit ?? DEFAULT_READ_LIMIT;

  // 走共享 helper：缓存 + 工作区边界 + ACP/直接 fs
  let fullContent: string;
  try {
    fullContent = await readFileWithCache(path, ctx);
  } catch (e) {
    log.debug("Read: read FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `read failed: ${(e as Error).message}`,
      "read",
      `Read: ${rel}`,
    );
  }

  // 标记为「已读」，给 Edit 的前置闸门用
  ctx.state.readPaths.add(path);
  log.debug("Read: completed", {
    path,
    totalLines: fullContent.split("\n").length,
    bytes: fullContent.length,
  });

  const locations = [{ path }];

  if (fullContent.length === 0) {
    const msg = "(File is empty)";
    return {
      resultText: msg,
      acpContent: [{ type: "content", content: { type: "text", text: msg } }],
      kind: "read",
      title: titleFor(args, rel),
      locations,
      ok: true,
    };
  }

  const allLines = fullContent.split("\n");
  // 文件以 \n 结尾时 split 会产生末尾空字符串 —— 丢掉避免渲染出幽灵空行
  if (allLines.length > 0 && allLines[allLines.length - 1] === "")
    allLines.pop();

  const startLine = offset ?? 1;
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(allLines.length, startIdx + effectiveLimit);
  const slice = allLines.slice(startIdx, endIdx);

  const numbered: string[] = [];
  let truncatedLines = 0;
  for (let i = 0; i < slice.length; i++) {
    let line = slice[i] ?? "";
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + TRUNCATED_LINE_SUFFIX;
      truncatedLines += 1;
    }
    const lineNo = startLine + i;
    numbered.push(`${String(lineNo).padStart(6, " ")}\t${line}`);
  }

  const headerParts: string[] = [];
  const showingFromTo = `lines ${startLine}-${startLine + slice.length - 1} of ${allLines.length}`;
  if (offset !== undefined || limit !== undefined || endIdx < allLines.length) {
    headerParts.push(`(showing ${showingFromTo})`);
    if (endIdx < allLines.length) {
      headerParts.push(
        `(${allLines.length - endIdx} more lines — call again with offset=${endIdx + 1} to continue)`,
      );
    }
  }
  if (truncatedLines > 0) {
    headerParts.push(
      `(${truncatedLines} long line(s) truncated to ${MAX_LINE_LENGTH} chars)`,
    );
  }

  const display =
    (headerParts.length > 0 ? headerParts.join("\n") + "\n" : "") +
    numbered.join("\n");

  return {
    resultText: display,
    acpContent: [{ type: "content", content: { type: "text", text: display } }],
    kind: "read",
    title: titleFor(args, rel),
    locations,
    ok: true,
  };
}

function titleFor(args: Record<string, unknown>, rel: string): string {
  // 标题以路径为主，对齐 Zed 第一方 agent 的 "Read <path>" / "Go to File"。
  // 故意不用 LLM 自由文案的 description —— 翻译过的标题会盖住路径，破坏跳转 UX。
  // description 仍然会进结果正文。
  const offset = args["offset"];
  return offset ? `Read ${rel} (lines ${String(offset)}+)` : `Read ${rel}`;
}

function isPositiveInt(v: unknown): boolean {
  return (
    typeof v === "number" && Number.isFinite(v) && v > 0 && Math.floor(v) === v
  );
}

export const readFileTool: Tool = {
  name: "Read",
  tier: "read",
  spec,
  execute,
};
