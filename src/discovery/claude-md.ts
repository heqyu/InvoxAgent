// CLAUDE.md 加载器 —— **兼容性薄 shim**。
//
// 历史：原本这里实现了「读 user/project 两级 CLAUDE.md + 解析 @reference + 自有 cache」
// 现状：实现已搬到 discovery/memory-providers.ts 的 claudeMdMemoryProvider；
//       本文件保留导出，作为旧代码（agent/system-prompt.ts、examples/smoke-claude-md.ts、
//       第三方脚本）继续工作的薄 shim，**新代码请直接读 discoverDirs(cwd).memories**。
//
// 行为契约（与旧版一致）：
//   - loadClaudeMd(cwd)        → ClaudeMdSection[]，user 在前 project 在后
//   - 同一 cwd 两次调用返回同一引用（`r1 === r2`）—— 通过 WeakMap 投影缓存实现
//   - clearClaudeMdCache(cwd?) → 转发到 clearDiscoveryCache，清掉 DiscoveryResult
//     的同时 WeakMap 自然失效

import { discoverDirs, clearDiscoveryCache } from "./index.js";
import type { DiscoveryResult } from "./types.js";

export interface ClaudeMdSection {
  /** 该段落来源 —— "user" 或 "project"。 */
  source: "user" | "project";
  /** 已展开 @reference 后的内容。 */
  content: string;
}

/**
 * 把 DiscoveryResult.memories（混合 provider）投影成「只看 claude-md 的」
 * 旧形状数组。投影结果按 DiscoveryResult 实例缓存（WeakMap），保证只要
 * discoverDirs 没被清缓存，loadClaudeMd 多次调用返回同一引用。
 */
const projectionCache = new WeakMap<DiscoveryResult, ClaudeMdSection[]>();

/**
 * 加载并解析 user / project 两级 CLAUDE.md。
 * 返回数组（user 在前，project 在后），都不存在则返回空数组。
 *
 * **新代码不要再调本函数**：请用 `discoverDirs(cwd).memories`，可以拿到
 * 来自其他 MemoryProvider（未来的 session-notes / RAG 等）的全部记忆。
 */
export function loadClaudeMd(cwd: string): ClaudeMdSection[] {
  const result = discoverDirs(cwd);

  const cached = projectionCache.get(result);
  if (cached) return cached;

  const sections: ClaudeMdSection[] = [];
  for (const m of result.memories) {
    if (m.provider !== "claude-md") continue;
    if (m.source !== "user" && m.source !== "project") continue;
    sections.push({ source: m.source, content: m.content });
  }

  projectionCache.set(result, sections);
  return sections;
}

/**
 * 兼容性 API —— 转发到 clearDiscoveryCache。
 * 清掉底层 DiscoveryResult 的同时，WeakMap 投影自然随之失效。
 */
export function clearClaudeMdCache(cwd?: string): void {
  clearDiscoveryCache(cwd);
}
