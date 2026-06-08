// Write 工具：直接写磁盘整体创建或覆盖文件。
//
// 当文件存在但 LLM 还没 Read 过时，给一句"软提示" advisory 提醒 LLM
// 优先 Read → Edit。写完更新缓存供后续 Read 命中。
//
// 关键决策：始终走 Node fs 直写，不调 ACP writeTextFile。
// 历史事故：ACP writeTextFile 在 Zed 等编辑器实现里会经过 save 管线，
// 触发 lua/ts/python 等语言服务器的 format-on-save，重排 end 缩进、剥
// trailing whitespace、tab→spaces、强制末尾换行 …… 整文件被静默篡改，
// git diff 一片飘红。直接 fs 写盘是唯一能保证字节级原样落盘的路径。

import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import {
  isInsideWorkspace,
  readFileDirect,
  writeFileDirect,
  resolveToolPath,
  detectEolInfo,
  toEol,
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
      },
      required: ["path", "content"],
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

  // 取旧文本（仅用于 diff 卡显示 + 判断 fileExisted）：
  // 优先缓存；否则直接 readFileDirect 读磁盘原文，绕开 ACP 的 buffer 视图，
  // 避免拿到被语言服务器/格式化器在 buffer 里改过的版本（写入会被它污染过）。
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
      log.debug("Write: reading old text via direct fs", { path });
      oldText = await readFileDirect(path);
      log.debug("Write: direct fs read for diff succeeded", {
        path,
        bytes: oldText.length,
      });
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

  // 行尾保护：仅在「覆盖已有 CRLF 文件」时把 content 转回 CRLF。
  // 动机与 Edit 一致 —— ACP / 编辑器读出的 oldText 通常已被归一化为 LF，
  // LLM 也几乎只产出 LF，直接灌回去会让 git 看到整文件 EOL 翻转。
  // 新建文件则不强制 EOL，让 content 自决（避免在纯 LF 仓库里突然写出
  // CRLF 这种反向意外）。
  // mixed 文件按多数派 dominant 归一化（修复历史伤疤）。
  let textToWrite = content;
  if (fileExisted) {
    const eol = await detectEolInfo(path);
    if (eol?.dominant === "crlf") {
      textToWrite = toEol(content, "crlf");
      if (textToWrite !== content) {
        log.debug("Write: normalizing to CRLF on overwrite", {
          path,
          diskStyle: eol.style,
          crlf: eol.crlfCount,
          lf: eol.lfCount,
          lfBytes: content.length,
          outBytes: textToWrite.length,
        });
      }
    }
  }

  // 写盘：始终走 Node fs，绕开 ACP writeTextFile —— 防止编辑器 save
  // 管线触发 autoformat / format-on-save 篡改 content。
  try {
    log.debug("Write: writing via direct fs", {
      path,
      bytes: textToWrite.length,
      insideWorkspace: inside,
    });
    await writeFileDirect(path, textToWrite);
    log.debug("Write: direct fs write succeeded", { path });
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

  // 缓存与 Edit 同策略：存 LF 版（content），与 ACP 读回的归一化形式对齐，
  // 避免下次 Edit 用 LF old_string 匹配 CRLF 缓存而失配。
  // 我们准确知道磁盘上是 textToWrite，但缓存模拟"编辑器视角"的 LF。
  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);
  log.debug("Write: completed", {
    path,
    bytes: textToWrite.length,
    fileExisted,
    outsideWorkspace: !inside,
  });

  return {
    resultText: `${advisory}wrote ${textToWrite.length} bytes to ${rel}`,
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
