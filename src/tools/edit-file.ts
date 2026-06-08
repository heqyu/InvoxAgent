// Edit 工具：精确字符串替换 + 唯一性强制。
//
// 强制 read-before-edit，让 LLM 不能盲目改文件。
// 没读过会自动通过 fs-utils 走缓存或 ACP 读一次（read flag 同时置位）。

import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import {
  isInsideWorkspace,
  readFileWithCache,
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

  if (inside && !ctx.caps.fs?.readTextFile) {
    log.debug("Edit: ACP fs.readTextFile capability missing", {
      path,
      hasReadTextFile: !!ctx.caps.fs?.readTextFile,
    });
    return errorResult(
      "client must advertise fs.readTextFile capability for Edit",
      "edit",
      `Edit: ${rel}`,
    );
  }
  log.debug("tool: Edit", {
    path,
    replaceAll,
    oldLen: oldString.length,
    newLen: newString.length,
    outsideWorkspace: !inside,
  });

  // auto-read：保证 readPaths 标记 & cache 命中，但不再把它当成替换基底。
  // 真正的替换基底见下方 readFileDirect —— 必须直读磁盘，不能用 ACP buffer。
  const hasBeenRead = ctx.state.readPaths.has(path);
  try {
    await readFileWithCache(path, ctx);
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

  // ────────────────────────────────────────────────────────────────────
  // 替换源 = 磁盘原文（不是 cache / ACP buffer）
  //
  // 之前发现的真实事故：编辑器（如 Zed）的 ACP writeTextFile 经过 save
  // 管线，会触发语言服务器/格式化器对 buffer 做 autoformat（重排 lua end
  // 缩进、tab→spaces、trailing whitespace 剥除、强制末尾换行 …）。如果
  // 我们在 cache（来自 ACP 的 buffer 视图）上做替换、再写回 ACP，整文件
  // 那些「LLM 没碰但被 autoformatter 改了」的行都会随之落盘 —— git diff
  // 一片飘红，淹没真实改动。
  //
  // 根治：
  //   1. 直接 readFileDirect 拿磁盘真实字节作为替换基底；
  //   2. 用 writeFileDirect 直接落盘，绕开 ACP writeTextFile，避免任何
  //      编辑器侧的 save-pipeline 改写内容；
  //   3. cache 仍然按 ACP 视角更新（LF 版），让后续 Edit 的 old_string
  //      匹配能继续走 LF / 编辑器视图风格。
  //
  // ACP readTextFile 还是要走（cache 命中能加速 Read 工具），只是不再当
  // 替换基底。
  let diskText: string;
  try {
    diskText = await readFileDirect(path);
  } catch (e) {
    log.debug("Edit: disk read FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `read for edit failed: ${(e as Error).message}`,
      "edit",
      `Edit: ${rel}`,
    );
  }

  // 行尾归一化：LLM 的 old_string / new_string 几乎只用 LF。把磁盘文本
  // 与 old/new 三方都转到同一个统一基线（LF）做替换，最后整体回写时按
  // 主导风格（dominant，多半 CRLF）转回去 —— 这样：
  //   - LLM 给的 LF old_string 能在磁盘 CRLF 文本里成功匹配；
  //   - mixed 文件里残留的孤立 LF 会被主导风格统一收编，git 一次性归零。
  const eol = await detectEolInfo(path);
  const target = eol?.dominant ?? null;
  const diskLf = toEol(diskText, "lf");
  const oldLf = toEol(oldString, "lf");
  const newLf = toEol(newString, "lf");

  // 严格语义计算新内容（在 LF 基线上）
  let newLfText: string;
  let occurrenceCount: number;
  if (replaceAll) {
    if (!diskLf.includes(oldLf)) {
      log.debug("Edit: old_string not found on disk (replace_all)", { path });
      return errorResult(
        `old_string not found in ${rel}`,
        "edit",
        `Edit: ${rel}`,
      );
    }
    occurrenceCount = diskLf.split(oldLf).length - 1;
    newLfText = diskLf.split(oldLf).join(newLf);
    log.debug("Edit: replace_all matched", {
      path,
      occurrences: occurrenceCount,
    });
  } else {
    const firstIdx = diskLf.indexOf(oldLf);
    if (firstIdx < 0) {
      return errorResult(
        `old_string not found in ${rel}. Read the file again and copy the exact text including whitespace.`,
        "edit",
        `Edit: ${rel}`,
      );
    }
    const secondIdx = diskLf.indexOf(oldLf, firstIdx + 1);
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
    newLfText =
      diskLf.slice(0, firstIdx) + newLf + diskLf.slice(firstIdx + oldLf.length);
  }

  // 整体转回主导 EOL（CRLF / LF）。null（无换行的小文件）保持 LF 即可。
  const textToWrite = target === "crlf" ? toEol(newLfText, "crlf") : newLfText;

  // 没改动：拒绝写盘（即便 mixed → 归一化也算不上 LLM 想要的"实质修改"，
  // 那种归一化应该作为附带效果发生在真实 Edit 上而不是空 Edit 上）
  if (textToWrite === diskText) {
    return errorResult(
      `no change: old_string and new_string produce identical content`,
      "edit",
      `Edit: ${rel}`,
    );
  }

  if (eol && target === "crlf" && textToWrite !== newLfText) {
    log.debug("Edit: normalized to CRLF on write", {
      path,
      diskStyle: eol.style,
      crlf: eol.crlfCount,
      lf: eol.lfCount,
    });
  }

  // 写盘：始终走 Node fs，绕开 ACP writeTextFile —— 防止编辑器 save 管线
  // 触发 autoformat / format-on-save 篡改我们的 newText。
  try {
    log.debug("Edit: writing via direct fs", {
      path,
      bytes: textToWrite.length,
      insideWorkspace: inside,
    });
    await writeFileDirect(path, textToWrite);
    log.debug("Edit: direct fs write succeeded", { path });
  } catch (e) {
    log.debug("Edit: write FAILED", { path, error: (e as Error).message });
    return errorResult(
      `edit write failed: ${(e as Error).message}`,
      "edit",
      `Edit: ${rel}`,
    );
  }

  // 缓存按 ACP 视角更新（LF 版本）—— 编辑器 buffer 在用户 reload 后会
  // 再次读到磁盘的真实 EOL 版本，但 cache 命中前我们提供 LF 视图保证
  // 后续 Edit 的 old_string 能成功匹配。
  ctx.state.cache.set(path, newLfText);
  log.debug("Edit: completed", {
    path,
    occurrences: occurrenceCount,
    diskBytes: diskText.length,
    newBytes: textToWrite.length,
    outsideWorkspace: !inside,
  });

  return {
    resultText: `edited ${rel}: replaced ${occurrenceCount} occurrence(s)`,
    acpContent: [
      {
        type: "diff",
        path,
        // diff 卡显示用 LF 视图，让 Zed 渲染干净；磁盘上是 textToWrite
        oldText: toEol(diskText, "lf"),
        newText: newLfText,
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
