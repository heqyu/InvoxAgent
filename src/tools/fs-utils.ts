// 工作区外文件 I/O 的共享 helper。
//
// 当解析后的路径在 ctx.cwd 内时，工具走 ACP fs 能力（让 Zed 跟踪 dirty buffer
// 并提供 undo / 编辑器集成）；当路径在工作区外（例如另一个仓库、Windows
// 上的另一块盘、用户从 Bash 工具拿到的 Unix 模拟层路径），ACP 不再管辖，
// 我们退回到 Node 原生 fs。

import { dirname, normalize, sep, resolve } from "node:path";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { ToolExecContext } from "./types.js";

/**
 * Windows 下把 Git Bash / MSYS2 / Cygwin 风格的 Unix 路径转换为原生 Windows 路径：
 *   /d/foo/bar  →  D:\foo\bar
 *   /C/Users    →  C:\Users
 *   /d          →  D:\
 * LLM 从 Bash 工具（在 Git Bash / MSYS2 下运行）读到这种路径后，可能直接
 * 把它当参数传回文件 I/O 工具。
 * POSIX 上原样返回。
 */
export function normalizeInputPath(input: string): string {
  if (process.platform !== "win32") return input;
  // /X/rest 或 /X（单字母盘符位于 Unix root）
  const m = input.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (!m) return input;
  const drive = (m[1] as string).toUpperCase();
  const rest = ((m[2] as string | undefined) ?? "").replace(/\//g, "\\");
  return `${drive}:${rest || "\\"}`;
}

/**
 * 把工具传入的路径（相对 / 原生绝对 / Git Bash 风格）相对会话 cwd 解析为
 * 规范化的绝对路径。所有文件 I/O 工具都从这里走单一入口。
 */
export function resolveToolPath(cwd: string, input: string): string {
  return resolve(cwd, normalizeInputPath(input));
}

/**
 * 判断 resolvedPath 是否在 workspaceRoot 之内（含 root 自身）。
 * 两个入参都应当已经是绝对路径。
 *
 * 用前缀比较而非 path.relative()，原因：
 *  1. Windows 跨盘：relative("G:\\a", "C:\\b") 返回的就是 target 绝对路径，
 *     很难仅靠返回值判断是否"在外"
 *  2. 概念更简单："inside" = "starts with root prefix"
 *
 * 末尾分隔符兜底：避免 "/workspace-extra" 误匹配 "/workspace"。
 * Windows 下大小写不敏感（NTFS 默认）。
 */
export function isInsideWorkspace(
  resolvedPath: string,
  workspaceRoot: string,
): boolean {
  const normPath = normalize(resolvedPath);
  const normRoot = normalize(workspaceRoot);
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : normRoot + sep;

  if (process.platform === "win32") {
    const p = normPath.toLowerCase();
    const r = normRoot.toLowerCase();
    const rs = rootWithSep.toLowerCase();
    return p === r || p.startsWith(rs);
  }
  return normPath === normRoot || normPath.startsWith(rootWithSep);
}

/** 通过 Node fs 直接读文本文件（绕过 ACP）。 */
export async function readFileDirect(path: string): Promise<string> {
  return readFile(path, { encoding: "utf-8" });
}

/**
 * 通过 Node fs 直接写文本文件（绕过 ACP）。
 * 自动 mkdir -p：缺失的父目录会被一次性创建。
 */
export async function writeFileDirect(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf-8" });
}

/**
 * 带缓存与工作区边界判定的读文件：
 *   1. 命中缓存即返回
 *   2. 否则按是否在工作区内走 ACP / 直接 fs
 *   3. 写入缓存供后续命中
 *
 * 这是 Read、Edit (auto-read)、未来需要"读到缓存里"的工具的唯一入口。
 */
export async function readFileWithCache(
  resolvedPath: string,
  ctx: ToolExecContext,
): Promise<string> {
  const cached = ctx.state.cache.get(resolvedPath);
  if (cached) return cached.content;

  const inside = isInsideWorkspace(resolvedPath, ctx.cwd);
  let content: string;
  if (inside) {
    if (!ctx.caps.fs?.readTextFile) {
      throw new Error("client does not advertise fs.readTextFile capability");
    }
    const res = await ctx.conn.readTextFile({
      sessionId: ctx.sessionId,
      path: resolvedPath,
    });
    content = res.content;
  } else {
    content = await readFileDirect(resolvedPath);
  }
  ctx.state.cache.set(resolvedPath, content);
  return content;
}

/** 检查文件是否存在且可读。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 文件行尾风格。`null` 表示文件不存在或不含任何换行。 */
export type EolStyle = "lf" | "crlf" | "mixed";

export interface EolInfo {
  /** 主导/唯一风格；mixed 时按多数派归类。 */
  dominant: "lf" | "crlf";
  /** 详细分类（含 mixed）。 */
  style: EolStyle;
  crlfCount: number;
  lfCount: number;
}

/**
 * 直接读磁盘原始字节，统计 \r\n（CRLF）与孤立 \n（LF）的出现次数。
 *
 * 必须绕过任何 ACP / 缓存通道：编辑器（如 Zed）在 readTextFile 时通常会
 * 把缓冲区行尾归一化成 LF，缓存里看到的内容已经丢失原始 EOL 信息，
 * 唯一可靠来源是磁盘原始 bytes。
 *
 * 返回 null：文件不存在 / 不含任何换行（无法判定）。
 *
 * mixed 文件如何处理由调用方决定 —— 但通常应当按 `dominant` 归一化：
 * 实际项目里 mixed 几乎全是「CRLF 文件被某个工具错误地局部改成了 LF」
 * 留下的伤疤，按多数派复原是恢复 git diff 干净的最直接办法。
 */
export async function detectEolInfo(path: string): Promise<EolInfo | null> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  let crlf = 0;
  let lonelyLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf++;
      else lonelyLf++;
    }
  }
  if (crlf === 0 && lonelyLf === 0) return null;
  let style: EolStyle;
  if (crlf > 0 && lonelyLf === 0) style = "crlf";
  else if (lonelyLf > 0 && crlf === 0) style = "lf";
  else style = "mixed";
  // 平手时偏向 CRLF：Windows 路径下 mixed 几乎总是「原 CRLF 被破坏」的产物。
  const dominant: "lf" | "crlf" = crlf >= lonelyLf ? "crlf" : "lf";
  return { dominant, style, crlfCount: crlf, lfCount: lonelyLf };
}

/**
 * 旧 API：仅返回风格分类。新代码请用 `detectEolInfo` 拿主导风格做归一化。
 */
export async function detectFileEol(path: string): Promise<EolStyle | null> {
  const info = await detectEolInfo(path);
  return info ? info.style : null;
}

/**
 * 把任意行尾混合的文本规范化为目标 EOL 风格。
 *
 * 实现：先把所有 \r\n 收敛成 \n（拿到一份纯 LF 视图），再按需要转回。
 * 这样无论传入文本是纯 LF、纯 CRLF 还是混合，结果都干净一致；对纯 LF 输入
 * 转 LF、纯 CRLF 输入转 CRLF 都是幂等的，不会产生 \r\r\n 这种坏结果。
 */
export function toEol(text: string, eol: "lf" | "crlf"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}
