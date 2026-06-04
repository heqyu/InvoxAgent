// 内置 MemoryProvider 实现集合。
//
// 当前仅一个：claudeMdMemoryProvider —— 读取 user / project 两级 CLAUDE.md，
// 并对其中行首的 `@filename` 做一层引用展开（不递归，避免循环）。
//
// 设计选择：
//   1. provider 实现独立成文件，是为了打破循环依赖
//      （discovery/index.ts → memory-providers.ts → ✗ claude-md.ts）。
//      claude-md.ts 现在反过来依赖 index.ts，作为对外的薄 shim。
//   2. readAndResolve 从原 claude-md.ts 整段搬过来，行为不变；
//      行内 @mention 不展开，只匹配「行首（允许前导空白）的 @」。
//   3. priority：user=10、project=20，对齐 memory-types.ts 的约定。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import type {
  MemoryProvider,
  MemoryProviderContext,
  MemorySection,
} from "./memory-types.js";

/**
 * CLAUDE.md provider —— Claude Code memory 体系的两级文件。
 *
 *   ~/.claude/CLAUDE.md       → priority 10（user-level）
 *   <cwd>/.claude/CLAUDE.md   → priority 20（project-level）
 *
 * Plugin 目录不参与 CLAUDE.md（与 Claude Code 行为一致 —— plugin 走 skill 而非 memory）。
 */
export const claudeMdMemoryProvider: MemoryProvider = {
  name: "claude-md",

  collect(ctx: MemoryProviderContext): MemorySection[] {
    const out: MemorySection[] = [];

    // user-level
    const userPath = join(ctx.userDir, "CLAUDE.md");
    const userContent = readAndResolve(userPath, ctx.userDir);
    if (userContent) {
      out.push({
        provider: "claude-md",
        source: "user",
        origin: userPath,
        content: userContent,
        priority: 10,
      });
    }

    // project-level
    const projectPath = join(ctx.projectDir, "CLAUDE.md");
    const projectContent = readAndResolve(projectPath, ctx.projectDir);
    if (projectContent) {
      out.push({
        provider: "claude-md",
        source: "project",
        origin: projectPath,
        content: projectContent,
        priority: 20,
      });
    }

    return out;
  },
};

/**
 * 内置 provider 列表。新增内置记忆来源时直接 push 到这里；
 * 第三方动态注册（registerMemoryProvider）留待第二步引入，本步不做。
 */
export const BUILTIN_MEMORY_PROVIDERS: MemoryProvider[] = [
  claudeMdMemoryProvider,
];

// ── helpers ──────────────────────────────────────────────────────────

/**
 * 读 CLAUDE.md 并解析行首 `@filename` 引用。
 *
 * 引用相对 baseDir（CLAUDE.md 所在目录）解析；只匹配「行首（允许前导空白）
 * 的 @」，行内 `@mention` 一律保留原样。例：
 *   @RTK.md          → 读 <baseDir>/RTK.md
 *   @scripts/foo.sh  → 读 <baseDir>/scripts/foo.sh
 *
 * 不递归展开（被引用文件里的 @ 不再展开），避免循环引用。
 * 文件不存在或读失败时，**返回 null** 让 caller 知道这一级没有内容。
 */
function readAndResolve(filePath: string, baseDir: string): string | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").trim();
  } catch (e) {
    log.warn("memory[claude-md]: failed to read", {
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
          log.warn("memory[claude-md]: @reference not found", {
            ref: refPath,
            resolved: refFullPath,
          });
          return `${indent}@${refPath} [file not found]`;
        }
        const refContent = readFileSync(refFullPath, "utf8").trim();
        log.debug("memory[claude-md]: resolved @reference", {
          ref: refPath,
          bytes: refContent.length,
        });
        return refContent;
      } catch (e) {
        log.warn("memory[claude-md]: failed to read @reference", {
          ref: refPath,
          error: e instanceof Error ? e.message : String(e),
        });
        return `${indent}@${refPath} [read error]`;
      }
    },
  );

  return resolved;
}
