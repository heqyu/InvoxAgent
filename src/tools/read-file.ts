// read_file: line-numbered, paginated reads with cache.

import { resolve } from "node:path";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { errorResult, type Tool, type ToolExecContext, type ToolExecResult } from "./types.js";

const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const TRUNCATED_LINE_SUFFIX = "… [truncated]";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a text file from the user's filesystem. Returns the file " +
      "contents prefixed with line numbers (cat -n style). Use offset+limit " +
      "to page through large files; the default cap is 2000 lines per call. " +
      "Single lines longer than 2000 chars are truncated. Empty files return " +
      "(File is empty). After read_file you may call edit_file on the same " +
      "path; without a prior read_file the edit will be rejected.",
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
          description:
            `Maximum lines to return. Optional; default ${DEFAULT_READ_LIMIT}.`,
        },
        description: DESCRIPTION_FIELD,
      },
      required: ["path", "description"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  if (!rel) return errorResult("missing 'path'", "read", "read_file");
  if (!ctx.caps.fs?.readTextFile) {
    return errorResult(
      "client does not advertise fs.readTextFile capability",
      "read",
      `read_file: ${rel}`,
    );
  }
  const path = resolve(ctx.cwd, rel);

  const offset = isPositiveInt(args["offset"]) ? Number(args["offset"]) : undefined;
  const limit = isPositiveInt(args["limit"]) ? Number(args["limit"]) : undefined;
  const effectiveLimit = limit ?? DEFAULT_READ_LIMIT;

  // Cache lookup: stores the FULL file content. Slicing per offset/limit
  // is done by us in-memory after the lookup, so different (offset, limit)
  // calls on the same path all benefit from one cache entry.
  let fullContent: string;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    log.info("tool: read_file (cache hit)", { path, offset, limit: effectiveLimit });
    fullContent = cached.content;
  } else {
    log.info("tool: read_file", { path, offset, limit: effectiveLimit });
    try {
      // We always pull the whole file into the cache. ACP supports `line`
      // and `limit` server-side, but caching only-the-slice would defeat
      // the purpose: the next read of a different range would miss.
      const res = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
      fullContent = res.content;
      ctx.state.cache.set(path, fullContent);
    } catch (e) {
      return errorResult(
        `read failed: ${(e as Error).message}`,
        "read",
        `read_file: ${rel}`,
      );
    }
  }

  // Mark for read-before-edit gate.
  ctx.state.readPaths.add(path);

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
  // If file ends with \n, split produces a trailing "" — drop it so we
  // don't show a phantom blank last line.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

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
    (headerParts.length > 0 ? headerParts.join("\n") + "\n" : "") + numbered.join("\n");

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
  // Title is path-first so Zed's tool card matches the "Read <path>" /
  // "Go to File" affordance shown for first-party agents. The LLM's
  // free-form `description` is intentionally NOT used as the title —
  // a translated/paraphrased title would hide the path and break the
  // jump-to-file UX. The description still flows into the result body.
  const offset = args["offset"];
  return offset ? `Read ${rel} (lines ${String(offset)}+)` : `Read ${rel}`;
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Math.floor(v) === v;
}

export const readFileTool: Tool = {
  name: "read_file",
  tier: "read",
  spec,
  execute,
};
