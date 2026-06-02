// Session persistence: dump/load OpenAI-shape conversation history to disk.
//
// Layout: <storeRoot>/<sessionId>.json
//   storeRoot defaults to "<cwd>/.invox/sessions"
//   override via INVOX_SESSION_DIR (absolute path)
//
// Stage 7.1 additions:
//   - `title` field: short human label derived from the first user message.
//     Surfaces in Zed's history panel instead of a UUID.
//   - prune(): drop sessions older than INVOX_SESSION_TTL_DAYS (default 30).
//     Run once on agent boot; cheap because we only stat updatedAt without
//     parsing the full history.
//
// CHOICE: per-cwd default. The history is project-scoped — opening a
// different project in Zed should bring up that project's past sessions,
// not leak chats across unrelated repos. Honoring an absolute env override
// keeps the door open for users who want a single global store.
//
// CHOICE: write-replace via temp file + rename. Avoids leaving a half-written
// JSON on disk if the process is killed mid-write.

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
import Database from "better-sqlite3";
import { log } from "./log.js";
import type { LLMMessage } from "./llm/types.js";

export interface PersistedSession {
  /** Schema version. Bump when breaking changes are made. */
  version: 1;
  id: string;
  cwd: string;
  /** Short human label. Synthesized from the first user message. */
  title?: string;
  /** Wall-clock ms when this file was first written. */
  createdAt: number;
  /** Wall-clock ms when last updated. */
  updatedAt: number;
  /** OpenAI-shape conversation history (matches Session.history). */
  history: LLMMessage[];
  /**
   * The model the user picked for this session via `setSessionModel`.
   * Optional and additive — older session JSONs lack this field, in which
   * case the agent falls back to the default model. Schema version stays
   * at 1: this is a backward-compatible extension.
   */
  selectedModel?: string;
  /**
   * Per-session ACP `setSessionConfigOption` values, keyed by configId.
   * Currently in use:
   *   - `system_prompt` — id of the active system prompt template
   *   - `thinking`      — "off" | "low" | "medium" | "high"
   *
   * Optional + additive same as `selectedModel`. Unknown keys are
   * dropped on load (forward-compat — a richer build may have written
   * keys this build doesn't recognize).
   */
  configValues?: Record<string, string>;
}

const DEFAULT_TTL_DAYS = 30;
const TITLE_MAX_LEN = 60;

/**
 * Derive a short human label from a session's history. Picks the first
 * user message, normalizes whitespace, truncates to TITLE_MAX_LEN with an
 * ellipsis. Returns "(empty)" if no user message exists yet.
 *
 * Exported so the agent can call it in-memory before persisting.
 */
export function titleFromHistory(history: LLMMessage[]): string {
  for (const m of history) {
    if (m.role !== "user") continue;
    const raw =
      typeof m.content === "string" ? m.content : userContentPreview(m.content);
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) continue;
    return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - 1) + "…";
  }
  return "(empty)";
}

import type { UserContent } from "./llm/types.js";

function userContentPreview(content: string | UserContent): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join(" ");
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

  /** Delete a session file from disk. Returns true if deleted, false if not found. */
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

  /** Persist a session. Creates parent dirs. Atomic via tmp+rename. */
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

  /** Read a session by id. Returns null if missing or unparsable. */
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
   * Delete sessions whose `updatedAt` is older than `now - ttlDays`.
   *
   * ttlDays = 0 disables pruning entirely (caller convention; we still treat
   * <=0 as "never prune" rather than "delete everything" since the latter
   * is too dangerous to be a default).
   *
   * Returns the number of files deleted (or 0 if the dir doesn't exist).
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
        // Reading the JSON metadata is cheap (the json stays under a few KB
        // typically; even a 100-message session is well under 100 KB). We
        // need updatedAt anyway, and using mtime would conflate "I rewrote
        // the file last week" with "the user touched it last week".
        const raw = readFileSync(fp, "utf8");
        const obj = JSON.parse(raw) as Partial<PersistedSession>;
        const updatedAt = typeof obj.updatedAt === "number" ? obj.updatedAt : 0;
        if (updatedAt > 0 && updatedAt < cutoff) {
          unlinkSync(fp);
          pruned += 1;
        }
      } catch {
        // Corrupt or unreadable — leave alone, don't risk deleting unrelated
        // user data.
      }
    }
    if (pruned > 0) {
      log.info("session prune", { ttlDays, pruned, root: this.root });
    }
    return pruned;
  }
}

/**
 * Locate all Zed `db.sqlite` files under `$LOCALAPPDATA/Zed/db/` (Windows),
 * `$XDG_DATA_HOME/Zed/db/` (Linux), or
 * `~/Library/Application Support/Zed/db/` (macOS).
 *
 * Returns absolute paths sorted newest-first by mtime.
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
      // Skip unreadable directories.
    }
  }
  return result;
}

/**
 * Delete session files that Zed no longer tracks.
 *
 * Zed stores ACP session IDs in `sidebar_threads.session_id` inside its
 * per-channel `db.sqlite` databases (e.g. `db/0-stable/db.sqlite`).
 * When the user archives or deletes a thread, the row is either marked
 * `archived=1` or removed entirely — but the agent is never notified via
 * ACP `session/delete`.
 *
 * This function cross-references on-disk `.json` session files against
 * every `sidebar_threads` row whose `folder_paths` contains `cwd`, and
 * removes any session file whose ID is absent from the database.
 *
 * Returns the number of orphaned files deleted.
 */
export function syncWithZedThreads(root: string, cwd: string): number {
  // Collect all session IDs currently on disk.
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

  // Collect all session_ids known to Zed for this project.
  const zedSessionIds = new Set<string>();
  const dbPaths = zedDbPaths();

  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        // sidebar_threads.session_id is the ACP session ID.
        // folder_paths contains the project root (may be comma-separated).
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
    } catch (e) {
      // Table may not exist in this database — skip silently.
    }
  }

  if (zedSessionIds.size === 0) {
    log.warn("syncWithZedThreads: no Zed threads found", {
      cwd,
      dbsScanned: dbPaths.length,
    });
    return 0;
  }

  // Delete sessions whose ID is NOT in Zed's thread list.
  let deleted = 0;
  for (const id of diskIds) {
    if (!zedSessionIds.has(id)) {
      try {
        unlinkSync(join(root, `${id}.json`));
        deleted += 1;
      } catch {
        // Best-effort — don't crash on a single failure.
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
 * How many days to keep session histories. 0 (or negative / unparseable)
 * disables pruning entirely. Default 30.
 */
export function sessionTtlDays(): number {
  const raw = process.env["INVOX_SESSION_TTL_DAYS"];
  if (raw === undefined) return DEFAULT_TTL_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
  return Math.max(0, n);
}
