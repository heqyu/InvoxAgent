// Shared helpers for filesystem operations that fall outside the workspace.
//
// When a resolved path lives inside `ctx.cwd` (the workspace root), tools
// delegate to ACP's fs capabilities so Zed can track dirty buffers and
// provide undo / editor integration. When the path is *outside* the workspace
// (e.g. a different repository the user asked the agent to inspect), we fall
// back to plain Node.js `fs` — ACP has no jurisdiction there.

import { relative } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { ToolExecContext } from "./types.js";

/**
 * Returns `true` when `resolvedPath` is (or is inside) `workspaceRoot`.
 * Uses `path.relative` so both POSIX and Windows paths work correctly, and
 * symlinks are *not* followed — matching the semantics of ACP's own
 * workspace scoping.
 */
export function isInsideWorkspace(
  resolvedPath: string,
  workspaceRoot: string,
): boolean {
  const rel = relative(workspaceRoot, resolvedPath);
  // `relative` returns "" when both are identical, or a path without ".."
  // prefixes when the target is a descendant.  Any leading ".." means outside.
  return rel === "" || !rel.startsWith("..");
}

/** Read a text file directly via Node.js fs (bypasses ACP). */
export async function readFileDirect(path: string): Promise<string> {
  return readFile(path, { encoding: "utf-8" });
}

/** Write a text file directly via Node.js fs (bypasses ACP). */
export async function writeFileDirect(
  path: string,
  content: string,
): Promise<void> {
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
