// CLAUDE.md 加载器 —— 读取静态记忆文件并解析 @reference。
//
// Claude Code "memory" 体系有两级 CLAUDE.md：
//   1. User    : ~/.claude/CLAUDE.md       （个人偏好，全局生效）
//   2. Project : <cwd>/.claude/CLAUDE.md   （项目特定上下文）
// Plugin 目录不支持 CLAUDE.md。
//
// CLAUDE.md 中的 `@filename` 引用按文件所在目录解析。例如
// ~/.claude/CLAUDE.md 中的 `@RTK.md` 会读取 ~/.claude/RTK.md。
//
// 设计选择：只解析一层 @ 引用（被包含文件里的 @ 不再展开），
// 行为可预测，避免循环引用。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { discoverDirs } from "./index.js";

export interface ClaudeMdSection {
  /** 该段落来源 —— "user" 或 "project"。 */
  source: "user" | "project";
  /** 已展开 @reference 后的内容。 */
  content: string;
}

const claudeMdCache = new Map<string, ClaudeMdSection[]>();

export function clearClaudeMdCache(cwd?: string): void {
  if (cwd) claudeMdCache.delete(cwd);
  else claudeMdCache.clear();
}

/**
 * 加载并解析 user / project 两级 CLAUDE.md。
 * 返回数组（user 在前，project 在后），都不存在则返回空数组。
 * 按 cwd 缓存，本会话内重复调用零开销。
 */
export function loadClaudeMd(cwd: string): ClaudeMdSection[] {
  const cached = claudeMdCache.get(cwd);
  if (cached) return cached;

  const discovery = discoverDirs(cwd);
  const sections: ClaudeMdSection[] = [];

  // 1. 用户级 CLAUDE.md
  const userContent = readAndResolve(
    join(discovery.userDir, "CLAUDE.md"),
    discovery.userDir,
  );
  if (userContent) {
    sections.push({ source: "user", content: userContent });
  }

  // 2. 项目级 CLAUDE.md（优先级更高，但顺序追加在后面，由消费方决定语义）
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

/**
 * 读 CLAUDE.md 并解析 `@filename` 引用。
 *
 * 引用相对 baseDir（CLAUDE.md 所在目录）解析；只匹配「行首（允许前导空白）
 * 的 @」，行内 `@mention` 一律保留原样。例：
 *   @RTK.md          → 读 <baseDir>/RTK.md
 *   @scripts/foo.sh  → 读 <baseDir>/scripts/foo.sh
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
