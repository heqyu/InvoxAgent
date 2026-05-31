// Session persistence: dump/load OpenAI-shape conversation history to disk.
//
// Layout: <storeRoot>/<sessionId>.json
//   storeRoot defaults to "<cwd>/.invox/sessions"
//   override via INVOX_SESSION_DIR (absolute path)
//
// CHOICE: per-cwd default. The history is project-scoped — opening a
// different project in Zed should bring up that project's past sessions,
// not leak chats across unrelated repos. Honoring an absolute env override
// keeps the door open for users who want a single global store.
//
// CHOICE: write-replace via temp file + rename. Avoids leaving a half-written
// JSON on disk if the process is killed mid-write.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "./log.js";
import type { LLMMessage } from "./llm/types.js";

export interface PersistedSession {
  /** Schema version. Bump when breaking changes are made. */
  version: 1;
  id: string;
  cwd: string;
  /** Wall-clock ms when this file was first written. */
  createdAt: number;
  /** Wall-clock ms when last updated. */
  updatedAt: number;
  /** OpenAI-shape conversation history (matches Session.history). */
  history: LLMMessage[];
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
}
