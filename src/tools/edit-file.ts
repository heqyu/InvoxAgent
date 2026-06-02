// edit_file: precise string replacement with uniqueness enforcement.
//
// Forces read-before-edit so the LLM can't blindly modify a file. Reads from
// the cache (populated by read_file) when available; otherwise re-reads via
// ACP since the read flag is set.

import { resolve } from "node:path";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import {
  isInsideWorkspace,
  readFileDirect,
  writeFileDirect,
} from "./fs-utils.js";
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

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Apply a precise string replacement to a file. The exact `old_string` " +
      "is found and replaced with `new_string`. Strict semantics:\n" +
      "  - You MUST call read_file on the path before edit_file.\n" +
      "  - `old_string` must match EXACTLY (whitespace, indentation, newlines).\n" +
      "  - `old_string` must be UNIQUE in the file unless `replace_all=true`.\n" +
      "  - If old_string is not unique, expand it with surrounding context.\n" +
      "  - To create a brand-new file, use write_file (not edit_file).\n" +
      "Use this for surgical edits; use write_file for large rewrites.",
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
            "Exact text to replace, copied verbatim from read_file output.",
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
        description: DESCRIPTION_FIELD,
      },
      required: ["path", "old_string", "new_string", "description"],
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

  if (!rel) return errorResult("missing 'path'", "edit", "edit_file");
  if (!oldString) {
    return errorResult(
      "missing or empty 'old_string' (use write_file to create new files)",
      "edit",
      `edit_file: ${rel}`,
    );
  }

  const path = resolve(ctx.cwd, rel);
  const inside = isInsideWorkspace(path, ctx.cwd);
  log.debug("edit_file: resolved path", {
    rel,
    resolved: path,
    cwd: ctx.cwd,
    insideWorkspace: inside,
  });

  if (inside && (!ctx.caps.fs?.readTextFile || !ctx.caps.fs?.writeTextFile)) {
    log.debug("edit_file: ACP fs capabilities missing", {
      path,
      hasReadTextFile: !!ctx.caps.fs?.readTextFile,
      hasWriteTextFile: !!ctx.caps.fs?.writeTextFile,
    });
    return errorResult(
      "client must advertise both fs.readTextFile and fs.writeTextFile for edit_file",
      "edit",
      `edit_file: ${rel}`,
    );
  }
  log.info("tool: edit_file", {
    path,
    replaceAll,
    oldLen: oldString.length,
    newLen: newString.length,
    outsideWorkspace: !inside,
  });

  // Read-before-edit gate.
  const hasBeenRead = ctx.state.readPaths.has(path);
  log.debug("edit_file: read-before-edit gate", { path, hasBeenRead });
  if (!hasBeenRead) {
    return errorResult(
      `must call read_file on ${rel} before edit_file (so you see the exact text to replace)`,
      "edit",
      `edit_file: ${rel}`,
    );
  }

  // Get current text — prefer cache, fall back to read (ACP or direct fs).
  let currentText: string;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    log.debug("edit_file: current text from cache", {
      path,
      cachedBytes: cached.content.length,
    });
    currentText = cached.content;
  } else {
    try {
      if (inside) {
        log.debug("edit_file: re-reading via ACP for edit", { path });
        const r = await ctx.conn.readTextFile({
          sessionId: ctx.sessionId,
          path,
        });
        currentText = r.content;
        log.debug("edit_file: ACP re-read succeeded", {
          path,
          bytes: currentText.length,
        });
      } else {
        log.warn("tool: edit_file: reading OUTSIDE workspace", { path });
        log.debug("edit_file: re-reading via direct fs for edit", { path });
        currentText = await readFileDirect(path);
        log.debug("edit_file: direct fs re-read succeeded", {
          path,
          bytes: currentText.length,
        });
      }
      ctx.state.cache.set(path, currentText);
    } catch (e) {
      log.debug("edit_file: re-read FAILED", {
        path,
        error: (e as Error).message,
      });
      return errorResult(
        `read for edit failed: ${(e as Error).message}`,
        "edit",
        `edit_file: ${rel}`,
      );
    }
  }

  // Compute new content with strict semantics.
  let newText: string;
  let occurrenceCount: number;
  if (replaceAll) {
    if (!currentText.includes(oldString)) {
      log.debug("edit_file: old_string not found (replace_all)", { path });
      return errorResult(
        `old_string not found in ${rel}`,
        "edit",
        `edit_file: ${rel}`,
      );
    }
    occurrenceCount = currentText.split(oldString).length - 1;
    newText = currentText.split(oldString).join(newString);
    log.debug("edit_file: replace_all matched", {
      path,
      occurrences: occurrenceCount,
    });
  } else {
    const firstIdx = currentText.indexOf(oldString);
    if (firstIdx < 0) {
      return errorResult(
        `old_string not found in ${rel}. Read the file again and copy the exact text including whitespace.`,
        "edit",
        `edit_file: ${rel}`,
      );
    }
    const secondIdx = currentText.indexOf(oldString, firstIdx + 1);
    if (secondIdx >= 0) {
      return errorResult(
        `old_string is not unique in ${rel} (found at offset ${firstIdx} and ${secondIdx} at least). ` +
          `Either expand old_string with more surrounding context to make it unique, ` +
          `or pass replace_all=true to replace every occurrence.`,
        "edit",
        `edit_file: ${rel}`,
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
      `edit_file: ${rel}`,
    );
  }

  // Write back (ACP for workspace files, direct fs for external).
  try {
    if (inside) {
      log.debug("edit_file: writing via ACP", { path, bytes: newText.length });
      await ctx.conn.writeTextFile({
        sessionId: ctx.sessionId,
        path,
        content: newText,
      });
      log.debug("edit_file: ACP write succeeded", { path });
    } else {
      log.warn("tool: edit_file: writing OUTSIDE workspace", { path });
      log.debug("edit_file: writing via direct fs", {
        path,
        bytes: newText.length,
      });
      await writeFileDirect(path, newText);
      log.debug("edit_file: direct fs write succeeded", { path });
    }
  } catch (e) {
    log.debug("edit_file: write FAILED", { path, error: (e as Error).message });
    return errorResult(
      `edit write failed: ${(e as Error).message}`,
      "edit",
      `edit_file: ${rel}`,
    );
  }

  // Update cache to the post-edit content. We deliberately do NOT invalidate;
  // we replace, since we know exactly what's on disk now.
  ctx.state.cache.set(path, newText);
  log.debug("edit_file: completed", {
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
  // Path-first title — see read-file.ts for rationale (keeps "Go to File"
  // glance-able and prevents an LLM-translated description from hiding
  // the path).
  return `Edited ${rel}`;
}

export const editFileTool: Tool = {
  name: "edit_file",
  tier: "write",
  spec,
  execute,
};
