// write_file: full-file create/overwrite via ACP fs/write_text_file.
//
// Soft read-before-overwrite hint when the file already exists but the LLM
// hasn't read it. Cache is updated post-write so subsequent reads hit.

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
    name: "write_file",
    description:
      "Create a new text file or overwrite an existing one with the given " +
      "content. The client may render this as a diff. For modifying " +
      "existing files prefer edit_file (precise string replacement) over " +
      "write_file — write_file replaces the ENTIRE file content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path, or path relative to session cwd.",
        },
        content: {
          type: "string",
          description: "Full new contents of the file.",
        },
        description: DESCRIPTION_FIELD,
      },
      required: ["path", "content", "description"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rel = String(args["path"] ?? "");
  const content = String(args["content"] ?? "");
  if (!rel) return errorResult("missing 'path'", "edit", "write_file");
  const path = resolve(ctx.cwd, rel);
  const inside = isInsideWorkspace(path, ctx.cwd);
  log.debug("write_file: resolved path", {
    rel,
    resolved: path,
    cwd: ctx.cwd,
    insideWorkspace: inside,
  });

  if (inside && !ctx.caps.fs?.writeTextFile) {
    log.debug("write_file: ACP fs.writeTextFile capability missing", { path });
    return errorResult(
      "client does not advertise fs.writeTextFile capability",
      "edit",
      `write_file: ${rel}`,
    );
  }

  // Resolve old text: prefer cache, else read (ACP or direct fs), else null (new file).
  let oldText: string | null = null;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    log.debug("write_file: old text from cache", {
      path,
      cachedBytes: cached.content.length,
    });
    oldText = cached.content;
  } else {
    try {
      if (inside) {
        if (ctx.caps.fs?.readTextFile) {
          log.debug("write_file: reading old text via ACP", { path });
          const r = await ctx.conn.readTextFile({
            sessionId: ctx.sessionId,
            path,
          });
          oldText = r.content;
          log.debug("write_file: ACP read for diff succeeded", {
            path,
            bytes: oldText.length,
          });
        } else {
          log.debug(
            "write_file: skipping old-text read (no ACP readTextFile capability)",
            { path },
          );
        }
      } else {
        log.debug("write_file: reading old text via direct fs", { path });
        oldText = await readFileDirect(path);
        log.debug("write_file: direct fs read for diff succeeded", {
          path,
          bytes: oldText.length,
        });
      }
    } catch {
      log.debug("write_file: old-text read failed (treating as new file)", {
        path,
      });
      oldText = null;
    }
  }

  const fileExisted = oldText !== null;
  const wasRead = ctx.state.readPaths.has(path);
  log.debug("write_file: pre-write state", {
    path,
    fileExisted,
    wasRead,
    insideWorkspace: inside,
  });
  const advisory =
    fileExisted && !wasRead
      ? `Note: this file existed and was overwritten without being read first. ` +
        `For safety, prefer read_file → edit_file over write_file when modifying existing files.\n`
      : "";

  try {
    if (inside) {
      log.debug("write_file: writing via ACP", { path, bytes: content.length });
      await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
      log.debug("write_file: ACP write succeeded", { path });
    } else {
      log.warn("tool: write_file: writing OUTSIDE workspace", { path });
      log.debug("write_file: writing via direct fs", {
        path,
        bytes: content.length,
      });
      await writeFileDirect(path, content);
      log.debug("write_file: direct fs write succeeded", { path });
    }
  } catch (e) {
    log.debug("write_file: write FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `write failed: ${(e as Error).message}`,
      "edit",
      `write_file: ${rel}`,
    );
  }

  // After a successful write, the new content is the on-disk content.
  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);
  log.debug("write_file: completed", {
    path,
    bytes: content.length,
    fileExisted,
    outsideWorkspace: !inside,
  });

  return {
    resultText: `${advisory}wrote ${content.length} bytes to ${rel}`,
    acpContent: [
      {
        type: "diff",
        path,
        oldText,
        newText: content,
      },
    ],
    kind: "edit",
    title: titleFor(args, rel, fileExisted),
    locations: [{ path }],
    ok: true,
  };
}

function titleFor(
  _args: Record<string, unknown>,
  rel: string,
  existed: boolean,
): string {
  // Path-first title — see read-file.ts for rationale.
  return existed ? `Wrote ${rel}` : `Created ${rel}`;
}

export const writeFileTool: Tool = {
  name: "write_file",
  tier: "write",
  spec,
  execute,
};
