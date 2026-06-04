// Edit 工具：精确字符串替换 + 唯一性强制。
//
// 强制 read-before-edit，让 LLM 不能盲目改文件。
// 没读过会自动通过 fs-utils 走缓存或 ACP 读一次（read flag 同时置位）。

import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import {
  isInsideWorkspace,
  readFileWithCache,
  writeFileDirect,
  resolveToolPath,
} from "./fs-utils.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Edit",
    description:
      "Apply a precise string replacement to a file. The exact `old_string` " +
      "is found and replaced with `new_string`. Strict semantics:\n" +
      "  - `old_string` must match EXACTLY (whitespace, indentation, newlines).\n" +
      "  - `old_string` must be UNIQUE in the file unless `replace_all=true`.\n" +
      "  - If old_string is not unique, expand it with surrounding context.\n" +
      "  - To create a brand-new file, use Write (not Edit).\n" +
      "The file is auto-read from cache if available; no prior Read needed.\n" +
      "Use this for surgical edits; use Write for large rewrites.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path, or path relative to session cwd.",
        },
        old_string: {
          type: "string",
          description:
            "Exact text to replace, copied verbatim from Read output.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. May be empty (deletion).",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence (default false). When false, old_string " +
            "must be unique in the file.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  const oldString =
    typeof args["old_string"] === "string" ? args["old_string"] : "";
  const newString =
    typeof args["new_string"] === "string" ? args["new_string"] : "";
  const replaceAll = args["replace_all"] === true;

  if (!rel) return errorResult("missing 'path'", "edit", "Edit");
  if (!oldString) {
    return errorResult(
      "missing or empty 'old_string' (use Write to create new files)",
      "edit",
      `Edit: ${rel}`,
    );
  }

  const path = resolveToolPath(ctx.cwd, rel);
  const inside = isInsideWorkspace(path, ctx.cwd);
  log.debug("Edit: resolved path", {
    rel,
    resolved: path,
    cwd: ctx.cwd,
    insideWorkspace: inside,
  });

  if (inside && (!ctx.caps.fs?.readTextFile || !ctx.caps.fs?.writeTextFile)) {
    log.debug("Edit: ACP fs capabilities missing", {
      path,
      hasReadTextFile: !!ctx.caps.fs?.readTextFile,
      hasWriteTextFile: !!ctx.caps.fs?.writeTextFile,
    });
    return errorResult(
      "client must advertise both fs.readTextFile and fs.writeTextFile for Edit",
      "edit",
      `Edit: ${rel}`,
    );
  }
  log.info("tool: Edit", {
    path,
    replaceAll,
    oldLen: oldString.length,
    newLen: newString.length,
    outsideWorkspace: !inside,
  });

  // auto-read（共享 helper：缓存 + 边界 + ACP/直接 fs）
  const hasBeenRead = ctx.state.readPaths.has(path);
  let currentText: string;
  try {
    currentText = await readFileWithCache(path, ctx);
  } catch (e) {
    log.debug("Edit: auto-read FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `read for edit failed: ${(e as Error).message}`,
      "edit",
      `Edit: ${rel}`,
    );
  }
  if (!hasBeenRead) {
    log.info("Edit: auto-read before edit", { path });
    ctx.state.readPaths.add(path);
  }

  // 严格语义计算新内容
  let newText: string;
  let occurrenceCount: number;
  if (replaceAll) {
    if (!currentText.includes(oldString)) {
      log.debug("Edit: old_string not found (replace_all)", { path });
      return errorResult(
        `old_string not found in ${rel}`,
        "edit",
        `Edit: ${rel}`,
      );
    }
    occurrenceCount = currentText.split(oldString).length - 1;
    newText = currentText.split(oldString).join(newString);
    log.debug("Edit: replace_all matched", {
      path,
      occurrences: occurrenceCount,
    });
  } else {
    const firstIdx = currentText.indexOf(oldString);
    if (firstIdx < 0) {
      return errorResult(
        `old_string not found in ${rel}. Read the file again and copy the exact text including whitespace.`,
        "edit",
        `Edit: ${rel}`,
      );
    }
    const secondIdx = currentText.indexOf(oldString, firstIdx + 1);
    if (secondIdx >= 0) {
      return errorResult(
        `old_string is not unique in ${rel} (found at offset ${firstIdx} and ${secondIdx} at least). ` +
          `Either expand old_string with more surrounding context to make it unique, ` +
          `or pass replace_all=true to replace every occurrence.`,
        "edit",
        `Edit: ${rel}`,
      );
    }
    occurrenceCount = 1;
    newText =
      currentText.slice(0, firstIdx) +
      newString +
      currentText.slice(firstIdx + oldString.length);
  }

  if (newText === currentText) {
    return errorResult(
      `no change: old_string and new_string produce identical content`,
      "edit",
      `Edit: ${rel}`,
    );
  }

  // 写回（工作区内走 ACP，工作区外走直接 fs）
  try {
    if (inside) {
      log.debug("Edit: writing via ACP", { path, bytes: newText.length });
      await ctx.conn.writeTextFile({
        sessionId: ctx.sessionId,
        path,
        content: newText,
      });
      log.debug("Edit: ACP write succeeded", { path });
    } else {
      log.warn("tool: Edit: writing OUTSIDE workspace", { path });
      log.debug("Edit: writing via direct fs", {
        path,
        bytes: newText.length,
      });
      await writeFileDirect(path, newText);
      log.debug("Edit: direct fs write succeeded", { path });
    }
  } catch (e) {
    log.debug("Edit: write FAILED", { path, error: (e as Error).message });
    return errorResult(
      `edit write failed: ${(e as Error).message}`,
      "edit",
      `Edit: ${rel}`,
    );
  }

  // 缓存直接替换为新内容（不走 invalidate —— 我们准确知道磁盘上是什么）
  ctx.state.cache.set(path, newText);
  log.debug("Edit: completed", {
    path,
    occurrences: occurrenceCount,
    oldBytes: currentText.length,
    newBytes: newText.length,
    outsideWorkspace: !inside,
  });

  return {
    resultText: `edited ${rel}: replaced ${occurrenceCount} occurrence(s)`,
    acpContent: [
      {
        type: "diff",
        path,
        oldText: currentText,
        newText,
      },
    ],
    kind: "edit",
    title: titleFor(args, rel),
    locations: [{ path }],
    ok: true,
  };
}

function titleFor(_args: Record<string, unknown>, rel: string): string {
  // 标题以路径为主 —— 详细理由见 read-file.ts。
  return `Edited ${rel}`;
}

export const editFileTool: Tool = {
  name: "Edit",
  tier: "write",
  spec,
  execute,
};
