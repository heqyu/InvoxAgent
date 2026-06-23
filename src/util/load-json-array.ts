// 通用 JSON 数组加载器 —— 从文件读取 JSON 数组，逐条校验，失败跳过。
//
// 抽出原因（J2.5）：cli.ts:loadPromptTemplates 和
// templates/loader.ts:loadAgentsFromDir 结构同型（读文件 → parse → 校验 → 收集），
// 抽成通用工具消除重复。

import { readFileSync } from "node:fs";
import { createLogger } from "../log.js";

export interface JsonArrayLoadOptions<T> {
  /** 要读取的 JSON 文件绝对路径。 */
  filePath: string;
  /**
   * 必填：把单个 entry 校验并归一化成 T。
   * 校验失败返回 null（跳过该条目，仅 warn）。
   */
  validate: (entry: unknown, index: number) => T | null;
  /** 文件不存在 / 解析失败 / 空数组时的兜底值。 */
  fallback: T[];
  /** log scope，用于 log.warn 的 module 标识。 */
  logScope: string;
}

/**
 * 从 filePath 读取一个 JSON 数组，逐条调用 validate 校验。
 * 任何阶段失败（文件缺失 / 非法 JSON / 非数组 / 全部条目无效）
 * 都 warn 并返回 fallback，永不抛错。
 */
export function loadJsonArray<T>(opts: JsonArrayLoadOptions<T>): T[] {
  const log = createLogger(opts.logScope);
  try {
    const raw = readFileSync(opts.filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      log.warn(
        `${opts.filePath}: parsed value is not a non-empty array; using fallback`,
      );
      return opts.fallback;
    }
    const out: T[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const result = opts.validate(parsed[i], i);
      if (result !== null) {
        out.push(result);
      } else {
        log.warn(`${opts.filePath}: skipping invalid entry`, {
          entry: parsed[i],
        });
      }
    }
    if (out.length === 0) {
      log.warn(
        `${opts.filePath}: no valid entries after filtering; using fallback`,
      );
      return opts.fallback;
    }
    return out;
  } catch (err) {
    log.warn(`${opts.filePath}: load failed; using fallback`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return opts.fallback;
  }
}
