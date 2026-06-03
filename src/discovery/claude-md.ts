// CLAUDE.md loader — reads static memory files and resolves @references.
//
// Claude Code's "memory" system uses CLAUDE.md files at two levels:
//   1. User:    ~/.claude/CLAUDE.md       (personal preferences, always active)
//   2. Project: <cwd>/.claude/CLAUDE.md   (project-specific context)
//
// Plugin directories do NOT support CLAUDE.md.
//
// Within a CLAUDE.md, `@filename` references are resolved by reading the
// file relative to the CLAUDE.md's parent directory. For example,
// `@RTK.md` in ~/.claude/CLAUDE.md reads ~/.claude/RTK.md.
//
// CHOICE: Only one level of @resolution (no nested @ inside included files)
// to keep behavior predictable and avoid infinite loops.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { discoverDirs } from "./index.js";

// ── Types ───────────────────────────────────────────────────────────

export interface ClaudeMdSection {
  /** "user" or "project" — where this CLAUDE.md was found. */
  source: "user" | "project";
  /** The resolved content (with @references inlined). */
  content: string;
}

// ── Cache ───────────────────────────────────────────────────────────

const claudeMdCache = new Map<string, ClaudeMdSection[]>();

export function clearClaudeMdCache(cwd?: string): void {
  if (cwd) claudeMdCache.delete(cwd);
  else claudeMdCache.clear();
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Load and resolve CLAUDE.md from user and project directories.
 *
 * Returns an array of sections (user first, then project), each with
 * a `source` label and resolved `content`. Empty array if no CLAUDE.md
 * files exist.
 *
 * Cached by cwd — repeated calls within the same session skip re-reading.
 */
export function loadClaudeMd(cwd: string): ClaudeMdSection[] {
  const cached = claudeMdCache.get(cwd);
  if (cached) return cached;

  const discovery = discoverDirs(cwd);
  const sections: ClaudeMdSection[] = [];

  // 1. User-level CLAUDE.md (lowest priority, always present if exists)
  const userContent = readAndResolve(
    join(discovery.userDir, "CLAUDE.md"),
    discovery.userDir,
  );
  if (userContent) {
    sections.push({ source: "user", content: userContent });
  }

  // 2. Project-level CLAUDE.md (highest priority)
  const projectContent = readAndResolve(
    join(discovery.projectDir, "CLAUDE.md"),
    discovery.projectDir,
  );
  if (projectContent) {
    sections.push({ source: "project", content: projectContent });
  }

  claudeMdCache.set(cwd, sections);
  log.info("claude-md: loaded", {
    cwd,
    userFound: !!userContent,
    projectFound: !!projectContent,
    sectionCount: sections.length,
  });

  return sections;
}

// ── @reference resolution ───────────────────────────────────────────

/**
 * Read a CLAUDE.md file and resolve all `@filename` references.
 *
 * References are resolved relative to `baseDir` (the directory containing
 * the CLAUDE.md). Only top-level `@` on its own line are resolved.
 *
 * Pattern: `@<filename>` where filename is a non-whitespace path.
 * Examples:
 *   @RTK.md          → reads <baseDir>/RTK.md
 *   @scripts/foo.sh  → reads <baseDir>/scripts/foo.sh
 *
 * CHOICE: Only resolve `@` that starts a line (possibly with leading
 * whitespace). Inline `@mentions` in prose are left alone.
 */
function readAndResolve(filePath: string, baseDir: string): string | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").trim();
  } catch (e) {
    log.warn("claude-md: failed to read", {
      path: filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  if (!raw) return null;

  // Resolve @filename references (line-start only)
  const resolved = raw.replace(
    /^(\s*)@(\S[^\n]*)$/gm,
    (_match, indent: string, refPath: string) => {
      const refFullPath = join(baseDir, refPath);
      try {
        if (!existsSync(refFullPath)) {
          log.warn("claude-md: @reference not found", {
            ref: refPath,
            resolved: refFullPath,
          });
          return `${indent}@${refPath} [file not found]`;
        }
        const refContent = readFileSync(refFullPath, "utf8").trim();
        log.debug("claude-md: resolved @reference", {
          ref: refPath,
          bytes: refContent.length,
        });
        return refContent;
      } catch (e) {
        log.warn("claude-md: failed to read @reference", {
          ref: refPath,
          error: e instanceof Error ? e.message : String(e),
        });
        return `${indent}@${refPath} [read error]`;
      }
    },
  );

  return resolved;
}
