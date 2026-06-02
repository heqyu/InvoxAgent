// Read: line-numbered, paginated reads with cache.

import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { readFileWithCache, resolveToolPath } from "./fs-utils.js";
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

  // Read with cache (shared helper handles workspace boundary + ACP/direct fs).
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

  // Mark for read-before-edit gate.
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
  // If file ends with \n, split produces a trailing "" — drop it so we
  // don't show a phantom blank last line.
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
  // Title is path-first so Zed's tool card matches the "Read <path>" /
  // "Go to File" affordance shown for first-party agents. The LLM's
  // free-form `description` is intentionally NOT used as the title —
  // a translated/paraphrased title would hide the path and break the
  // jump-to-file UX. The description still flows into the result body.
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
