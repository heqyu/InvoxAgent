// Write 工具：通过 ACP fs/write_text_file 整体创建或覆盖文件。
//
// 当文件存在但 LLM 还没 Read 过时，给一句"软提示" advisory 提醒 LLM
// 优先 Read → Edit。写完更新缓存供后续 Read 命中。

import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import {
  isInsideWorkspace,
  readFileDirect,
  writeFileDirect,
  resolveToolPath,
} from "./fs-utils.js";
import { DESCRIPTION_FIELD } from "./shared.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Write",
    description:
      "Create a new text file or overwrite an existing one with the given " +
      "content. The client may render this as a diff. For modifying " +
      "existing files prefer Edit (precise string replacement) over " +
      "Write — Write replaces the ENTIRE file content.",
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
  if (!rel) return errorResult("missing 'path'", "edit", "Write");
  const path = resolveToolPath(ctx.cwd, rel);
  const inside = isInsideWorkspace(path, ctx.cwd);
  log.debug("Write: resolved path", {
    rel,
    resolved: path,
    cwd: ctx.cwd,
    insideWorkspace: inside,
  });

  if (inside && !ctx.caps.fs?.writeTextFile) {
    log.debug("Write: ACP fs.writeTextFile capability missing", { path });
    return errorResult(
      "client does not advertise fs.writeTextFile capability",
      "edit",
      `Write: ${rel}`,
    );
  }

  // 取旧文本：优先缓存，再走 ACP / 直接 fs，找不到则视为新文件
  let oldText: string | null = null;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    log.debug("Write: old text from cache", {
      path,
      cachedBytes: cached.content.length,
    });
    oldText = cached.content;
  } else {
    try {
      if (inside) {
        if (ctx.caps.fs?.readTextFile) {
          log.debug("Write: reading old text via ACP", { path });
          const r = await ctx.conn.readTextFile({
            sessionId: ctx.sessionId,
            path,
          });
          oldText = r.content;
          log.debug("Write: ACP read for diff succeeded", {
            path,
            bytes: oldText.length,
          });
        } else {
          log.debug(
            "Write: skipping old-text read (no ACP readTextFile capability)",
            { path },
          );
        }
      } else {
        log.debug("Write: reading old text via direct fs", { path });
        oldText = await readFileDirect(path);
        log.debug("Write: direct fs read for diff succeeded", {
          path,
          bytes: oldText.length,
        });
      }
    } catch {
      log.debug("Write: old-text read failed (treating as new file)", {
        path,
      });
      oldText = null;
    }
  }

  const fileExisted = oldText !== null;
  const wasRead = ctx.state.readPaths.has(path);
  log.debug("Write: pre-write state", {
    path,
    fileExisted,
    wasRead,
    insideWorkspace: inside,
  });
  const advisory =
    fileExisted && !wasRead
      ? `Note: this file existed and was overwritten without being read first. ` +
        `For safety, prefer Read → Edit over Write when modifying existing files.\n`
      : "";

  try {
    if (inside) {
      log.debug("Write: writing via ACP", { path, bytes: content.length });
      await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
      log.debug("Write: ACP write succeeded", { path });
    } else {
      log.warn("tool: Write: writing OUTSIDE workspace", { path });
      log.debug("Write: writing via direct fs", {
        path,
        bytes: content.length,
      });
      await writeFileDirect(path, content);
      log.debug("Write: direct fs write succeeded", { path });
    }
  } catch (e) {
    log.debug("Write: write FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `write failed: ${(e as Error).message}`,
      "edit",
      `Write: ${rel}`,
    );
  }

  // 写成功后缓存即等于磁盘内容，并标记已读
  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);
  log.debug("Write: completed", {
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
  // 标题以路径为主 —— 详细理由见 read-file.ts。
  return existed ? `Wrote ${rel}` : `Created ${rel}`;
}

export const writeFileTool: Tool = {
  name: "Write",
  tier: "write",
  spec,
  execute,
};
