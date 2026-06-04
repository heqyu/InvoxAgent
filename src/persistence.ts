// 会话持久化：把 OpenAI 形状的会话 history 落到磁盘。
//
// 文件布局：<storeRoot>/<sessionId>.json
//   storeRoot 默认 "<cwd>/.invox/sessions"
//   可由 INVOX_SESSION_DIR（绝对路径）覆盖
//
// 设计选择：
//   - 默认按 cwd 隔离 —— history 是项目级的；在 Zed 切到不同项目时应该看到
//     该项目自己的历史，不要跨仓库串味。允许通过 env 设置全局绝对路径，给
//     需要单全局存储的用户留口子。
//   - 写文件用 tmp + rename 原子替换，避免进程被杀时留下半成品 JSON。
//   - prune() 在 agent 启动时跑一次，按 INVOX_SESSION_TTL_DAYS（默认 30）
//     淘汰过期 session；只看 updatedAt，不解析完整 history，开销极低。
//   - title 字段：从首条 user message 派生的短可读标题，让 Zed 历史面板
//     看到真正的内容而不是 UUID。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "./log.js";
import type { LLMMessage } from "./llm/types.js";
import { contentToString } from "./llm/utils.js";

export interface PersistedSession {
  /** schema 版本。破坏性变更时递增。 */
  version: 1;
  id: string;
  cwd: string;
  /** 短可读标题，从首条 user message 派生。 */
  title?: string;
  /** 文件首次写入的 wall-clock 毫秒数。 */
  createdAt: number;
  /** 最近一次更新的 wall-clock 毫秒数。 */
  updatedAt: number;
  /** OpenAI 形状的会话 history（与 Session.history 对齐）。 */
  history: LLMMessage[];
  /**
   * 用户通过 setSessionModel 选定的 model。可选 + 向后兼容 ——
   * 旧 session 文件没这个字段，agent 会回退到默认 model。
   * 字段是新增的，但 schema 版本仍保持 1（向后兼容扩展）。
   */
  selectedModel?: string;
  /**
   * 按 configId 索引的 ACP setSessionConfigOption 值。
   * 当前使用：
   *   - "system_prompt" —— 当前 system prompt 模板的 id
   *   - "thinking"      —— "off" | "low" | "medium" | "high"
   *
   * 与 selectedModel 一样是可选 + additive。读时丢弃未识别的 key
   * （forward-compat：更新版本可能写入本版本不识别的 key）。
   */
  configValues?: Record<string, string>;
  /**
   * 上一次完成的 turn 用量快照。重启后保留，让用户重新加载会话时仍能看到
   * 上一轮花了多少 token。
   */
  lastTurnUsage?: {
    input: number;
    output: number;
    total: number;
    calls: number;
    maxPrompt: number;
    maxCached: number;
    cached: number;
    elapsedMs: number;
    model: string;
  };
}

const DEFAULT_TTL_DAYS = 30;
const TITLE_MAX_LEN = 60;

/**
 * 从 history 派生短标题：取第一条 user message，归一化空白，截断到
 * TITLE_MAX_LEN 并加省略号。无 user message 时返回 "(empty)"。
 *
 * 导出供 agent 在持久化前 in-memory 调用。
 */
export function titleFromHistory(history: LLMMessage[]): string {
  for (const m of history) {
    if (m.role !== "user") continue;
    const raw = contentToString(m.content);
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) continue;
    return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - 1) + "…";
  }
  return "(empty)";
}

export class SessionStore {
  private root: string;

  constructor(cwd: string) {
    const override = process.env["INVOX_SESSION_DIR"];
    if (override) {
      this.root = isAbsolute(override) ? override : resolve(cwd, override);
    } else {
      this.root = join(cwd, ".invox", "sessions");
    }
  }

  rootDir(): string {
    return this.root;
  }

  pathFor(sessionId: string): string {
    return join(this.root, `${sessionId}.json`);
  }

  has(sessionId: string): boolean {
    return existsSync(this.pathFor(sessionId));
  }

  /** 删除磁盘上的 session 文件；存在并删除成功返 true，否则返 false。 */
  delete(sessionId: string): boolean {
    const target = this.pathFor(sessionId);
    try {
      if (!existsSync(target)) return false;
      unlinkSync(target);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      log.warn("session delete failed", { sessionId, error: err.message });
      return false;
    }
  }

  /** 持久化 session。自动创建父目录；通过 tmp + rename 原子写。 */
  save(snapshot: PersistedSession): void {
    const target = this.pathFor(snapshot.id);
    const tmp = `${target}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      renameSync(tmp, target);
    } catch (e) {
      log.warn("session save failed", {
        sessionId: snapshot.id,
        error: (e as Error).message,
      });
    }
  }

  /** 按 id 读 session；不存在 / 解析失败返 null。 */
  load(sessionId: string): PersistedSession | null {
    const target = this.pathFor(sessionId);
    try {
      const raw = readFileSync(target, "utf8");
      const obj = JSON.parse(raw) as PersistedSession;
      if (obj.version !== 1) {
        log.warn("session: unsupported version", {
          sessionId,
          version: obj.version,
        });
        return null;
      }
      return obj;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        log.warn("session load failed", { sessionId, error: err.message });
      }
      return null;
    }
  }

  /**
   * 删除 updatedAt 早于 (now - ttlDays) 的 session。
   *
   * ttlDays = 0 表示完全关闭过期清理（约定：≤ 0 当作"永不清理"，避免
   * 把"全部删除"当默认行为）。
   * 返回实际删除的文件数（目录不存在返回 0）。
   */
  prune(ttlDays: number): number {
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return 0;
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return 0;
      log.warn("session prune: readdir failed", { error: err.message });
      return 0;
    }

    let pruned = 0;
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      const fp = join(this.root, f);
      try {
        // 读 JSON 元数据成本很低（典型几 KB；100 条消息也很少超过 100 KB）。
        // 我们要的就是 updatedAt；用 mtime 反而会把"上周重写过文件"误判为
        // "用户上周才动过"。
        const raw = readFileSync(fp, "utf8");
        const obj = JSON.parse(raw) as Partial<PersistedSession>;
        const updatedAt = typeof obj.updatedAt === "number" ? obj.updatedAt : 0;
        if (updatedAt > 0 && updatedAt < cutoff) {
          unlinkSync(fp);
          pruned += 1;
        }
      } catch {
        // 损坏 / 不可读 —— 不动它，避免误删用户数据
      }
    }
    if (pruned > 0) {
      log.info("session prune", { ttlDays, pruned, root: this.root });
    }
    return pruned;
  }
}

/**
 * 列出 Zed 的 db.sqlite 文件位置：
 *   Windows  : $LOCALAPPDATA/Zed/db/
 *   Linux    : $XDG_DATA_HOME/Zed/db/
 *   macOS    : ~/Library/Application Support/Zed/db/
 *
 * 返回按 mtime 倒序排列的绝对路径。
 */
function zedDbPaths(): string[] {
  const localAppData = process.env["LOCALAPPDATA"];
  const xdgData = process.env["XDG_DATA_HOME"];
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];

  const dbDirs: string[] = [];
  if (localAppData) dbDirs.push(join(localAppData, "Zed", "db"));
  if (xdgData) dbDirs.push(join(xdgData, "Zed", "db"));
  if (home) {
    dbDirs.push(join(home, "Library", "Application Support", "Zed", "db"));
    dbDirs.push(join(home, ".local", "share", "Zed", "db"));
  }

  const result: string[] = [];
  for (const dir of dbDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const dbFile = join(dir, entry, "db.sqlite");
        if (existsSync(dbFile)) result.push(dbFile);
      }
    } catch {
      // 跳过不可读目录
    }
  }
  return result;
}

/**
 * 删除 Zed 已经不再追踪的 session 文件。
 *
 * Zed 把 ACP session id 存在每个 channel 的 db.sqlite（如 `db/0-stable/db.sqlite`）
 * 的 sidebar_threads.session_id 字段里。用户在 Zed 里归档 / 删除某个 thread
 * 时，对应行被标 archived=1 或直接删除 —— 但 ACP `session/delete` 不会
 * 通知 agent，于是磁盘上会留孤儿 .json。
 *
 * 本函数把磁盘上每个 .json 与 folder_paths 含 cwd 的 sidebar_threads 行
 * 做交叉对比，删除那些 db 里已不存在的 session 文件。
 *
 * 返回被删除的孤儿文件数。
 */
export async function syncWithZedThreads(
  root: string,
  cwd: string,
): Promise<number> {
  // 收集磁盘上的 session id
  let diskIds: string[];
  try {
    diskIds = readdirSync(root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return 0;
    log.warn("syncWithZedThreads: readdir failed", { error: err.message });
    return 0;
  }

  if (diskIds.length === 0) return 0;

  // 懒加载 better-sqlite3：缺失原生二进制时不能让整个进程在 import 阶段挂掉。
  // 本函数是 best-effort —— 模块加载失败就静默跳过。
  let Database: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => {
    prepare(sql: string): {
      all(param: unknown): unknown[];
    };
    close(): void;
  };
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default;
  } catch (e) {
    log.warn("syncWithZedThreads: better-sqlite3 unavailable, skipping", {
      error: (e as Error).message,
    });
    return 0;
  }

  // 收集 Zed 知道的、属于本项目的 session id
  const zedSessionIds = new Set<string>();
  const dbPaths = zedDbPaths();

  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        // sidebar_threads.session_id 即 ACP session id；
        // folder_paths 含项目根（可能是逗号分隔多项）。
        const rows = db
          .prepare(
            `SELECT session_id FROM sidebar_threads
             WHERE session_id IS NOT NULL AND session_id != ''
               AND folder_paths LIKE ?`,
          )
          .all(`%${cwd}%`) as { session_id: string }[];
        for (const r of rows) zedSessionIds.add(r.session_id);
      } finally {
        db.close();
      }
    } catch {
      // 该 db 里可能没有这张表 —— 静默跳过
    }
  }

  if (zedSessionIds.size === 0) {
    log.warn("syncWithZedThreads: no Zed threads found", {
      cwd,
      dbsScanned: dbPaths.length,
    });
    return 0;
  }

  // 删除不在 Zed thread 列表里的 session
  let deleted = 0;
  for (const id of diskIds) {
    if (!zedSessionIds.has(id)) {
      try {
        unlinkSync(join(root, `${id}.json`));
        deleted += 1;
      } catch {
        // best-effort —— 单个失败不致命
      }
    }
  }

  if (deleted > 0) {
    log.info("syncWithZedThreads", {
      cwd,
      dbsScanned: dbPaths.length,
      diskIds: diskIds.length,
      zedIds: zedSessionIds.size,
      deleted,
    });
  }
  return deleted;
}

/**
 * session 过期天数。0（或负值 / 解析失败）禁用过期清理。默认 30 天。
 */
export function sessionTtlDays(): number {
  const raw = process.env["INVOX_SESSION_TTL_DAYS"];
  if (raw === undefined) return DEFAULT_TTL_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
  return Math.max(0, n);
}
