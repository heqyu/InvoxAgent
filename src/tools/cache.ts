// 每会话的文件内容缓存。
//
// 缓存动机：LLM 经常在一轮内对同一文件 Read 多次（先读前 50 行 → 推理 →
// 再读 50-100 行）。无缓存时每次都要走 ACP → Zed → 磁盘 一圈；有缓存
// 后同轮的重复读零成本。
//
// 失效规则：
//   1. Write / Edit 失效（或替换）该路径的条目
//   2. 缓存仅会话内有效（不跨 session / agent）
//   3. 不检测会话外的修改 —— 用户在编辑器里改文件后，LLM 下次 Read 仍可能
//      看到旧缓存。这是有意权衡：
//        - 实现简单
//        - LLM 工作流极少与人工编辑在同一轮交错
//        - Agent 自己写文件时走 ACP writeTextFile，编辑器状态会同步
//      若证伪，下一步可在 Read 前 stat 文件并比 mtime。

export interface CacheEntry {
  /** 最近一次读到 / 写入后的完整文本内容。 */
  content: string;
  /** 写入时间，仅供诊断日志用，不参与失效判断。 */
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

  /** 诊断快照，debug 日志用。 */
  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.map.size, hits: this.hits, misses: this.misses };
  }
}
