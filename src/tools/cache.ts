// Per-session file content cache.
//
// Why cache: the LLM commonly reads the same file multiple times in one turn
// (e.g. read first 50 lines → reason → read lines 50-100). Without a cache
// each call goes through ACP → Zed → disk → back. With a cache, repeats
// within a turn are free.
//
// Invalidation rules:
//   1. Write / Edit invalidate (or replace) the entry for that path
//   2. The cache is per-session (not shared across sessions/agents)
//   3. We do NOT detect external mutations within a session — if the user
//      edits the file in their editor between two Read calls, the LLM
//      may see the stale cache. This is a deliberate trade-off:
//        - keeping it simple
//        - the LLM-driven workflow rarely interleaves with manual edits
//          mid-turn, and Zed's writeTextFile path keeps editor state in sync
//          when the agent is the one writing
//      If this proves wrong, the upgrade is straightforward: stat the file
//      via a bash tool before each read and compare mtime.

export interface CacheEntry {
  /** Full text content of the file, as last read or written. */
  content: string;
  /** When we cached it (only used for diagnostic logs, not invalidation). */
  cachedAt: number;
}

export class FileCache {
  private map = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  get(path: string): CacheEntry | undefined {
    const e = this.map.get(path);
    if (e) this.hits += 1;
    else this.misses += 1;
    return e;
  }

  set(path: string, content: string): void {
    this.map.set(path, { content, cachedAt: Date.now() });
  }

  invalidate(path: string): void {
    this.map.delete(path);
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  /** Diagnostic snapshot, useful when logging at debug level. */
  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.map.size, hits: this.hits, misses: this.misses };
  }
}
