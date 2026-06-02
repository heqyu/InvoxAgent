// Shared helpers for filesystem operations that fall outside the workspace.
//
// When a resolved path lives inside `ctx.cwd` (the workspace root), tools
// delegate to ACP's fs capabilities so Zed can track dirty buffers and
// provide undo / editor integration. When the path is *outside* the workspace
// (e.g. a different repository, a different drive on Windows, or a path the
// user found via a Bash tool running in a Unix-emulation layer), we fall back
// to plain Node.js `fs` — ACP has no jurisdiction there.

import { dirname, normalize, sep, resolve } from "node:path";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { ToolExecContext } from "./types.js";

/**
 * On Windows, convert a Git Bash / MSYS2 / Cygwin-style Unix path to a
 * native Windows path:
 *   /d/foo/bar  →  D:\foo\bar
 *   /C/Users    →  C:\Users
 *   /d          →  D:\
 * These paths appear when the LLM reads output from the Bash tool (which
 * runs under Git Bash / MSYS2) and passes the path back into a file I/O
 * tool argument.
 * On POSIX, returns the path unchanged.
 */
export function normalizeInputPath(input: string): string {
  if (process.platform !== "win32") return input;
  // /X/rest  or  /X  (single drive letter at Unix root)
  const m = input.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (!m) return input;
  const drive = (m[1] as string).toUpperCase();
  const rest = ((m[2] as string | undefined) ?? "").replace(/\//g, "\\");
  return `${drive}:${rest || "\\"}`;
}

/**
 * Resolve a tool-supplied path (relative, absolute native, or Git Bash
 * style) against the session cwd, returning a normalized absolute path.
 * This is the single entry point for path resolution in all file I/O tools.
 */
export function resolveToolPath(cwd: string, input: string): string {
  return resolve(cwd, normalizeInputPath(input));
}

/**
 * Returns `true` when `resolvedPath` is (or is inside) `workspaceRoot`.
 * Both inputs should already be absolute paths (from resolveToolPath / ctx.cwd).
 *
 * Uses prefix comparison rather than path.relative() for two reasons:
 *  1. Cross-drive paths on Windows: relative("G:\\a", "C:\\b") returns the
 *     absolute target path unchanged — impossible to detect as "outside"
 *     without an extra isAbsolute() guard.
 *  2. Conceptually simpler: "inside" means "starts with the root prefix".
 *
 * Trailing-separator guard prevents "/workspace-extra" from matching
 * "/workspace". On Windows, comparison is case-insensitive (NTFS convention).
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

/** Read a text file directly via Node.js fs (bypasses ACP). */
export async function readFileDirect(path: string): Promise<string> {
  return readFile(path, { encoding: "utf-8" });
}

/**
 * Write a text file directly via Node.js fs (bypasses ACP).
 * Creates any missing ancestor directories automatically (mkdir -p semantics).
 */
export async function writeFileDirect(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf-8" });
}

/**
 * Read a file with cache and workspace-boundary awareness.
 *
 * 1. Returns from cache if available.
 * 2. Otherwise reads via ACP (inside workspace) or direct fs (outside).
 * 3. Populates the cache for subsequent calls.
 *
 * This is the single source of truth for "read a file into the cache"
 * shared by Read, Edit (auto-read), and any future tool that needs it.
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

/** Check whether a file exists and is readable. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
