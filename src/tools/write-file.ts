// write_file: full-file create/overwrite via ACP fs/write_text_file.
//
// Soft read-before-overwrite hint when the file already exists but the LLM
// hasn't read it. Cache is updated post-write so subsequent reads hit.

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
  if (!ctx.caps.fs?.writeTextFile) {
    return errorResult(
      "client does not advertise fs.writeTextFile capability",
      "edit",
      `write_file: ${rel}`,
    );
  }
  const path = resolve(ctx.cwd, rel);
  log.info("tool: write_file", { path, bytes: content.length });

  // Resolve old text: prefer cache, else ACP read, else null (new file).
  let oldText: string | null = null;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    oldText = cached.content;
  } else if (ctx.caps.fs?.readTextFile) {
    try {
      const r = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
      oldText = r.content;
    } catch {
      oldText = null;
    }
  }

  const fileExisted = oldText !== null;
  const wasRead = ctx.state.readPaths.has(path);
  const advisory =
    fileExisted && !wasRead
      ? `Note: this file existed and was overwritten without being read first. ` +
        `For safety, prefer read_file → edit_file over write_file when modifying existing files.\n`
      : "";

  try {
    await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
  } catch (e) {
    return errorResult(`write failed: ${(e as Error).message}`, "edit", `write_file: ${rel}`);
  }

  // After a successful write, the new content is the on-disk content.
  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);

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
    ok: true,
  };
}

function titleFor(args: Record<string, unknown>, rel: string, existed: boolean): string {
  const desc = typeof args["description"] === "string" ? args["description"].trim() : "";
  if (desc) return desc;
  return existed ? `Wrote ${rel}` : `Created ${rel}`;
}

export const writeFileTool: Tool = {
  name: "write_file",
  tier: "write",
  spec,
  execute,
};
