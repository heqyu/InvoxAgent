// Token 渲染助手 —— Phase A2.3 拆分
//
// 从 agent.ts 抽出 token 显示与 context window 解析相关的纯函数：
//   - humanizeTokens —— 数字 → "1.2k" / "1.2M" 的 Zed 风格短文本
//   - contextWindowFor —— model id → 推测的最大 context window（带 env 覆盖
//     和内置常见模型族表）
//   - CONTEXT_WINDOW_TABLE —— 子串匹配的「家族 → 容量」映射表
//
// 这是 reportTurnUsage 渲染 token 计费时用的，独立可测；后续 A2.x 拆分
// prompt-loop / token-reporter 时也会被复用。

/**
 * Render an integer token count the way Zed does in its token-meter tooltip:
 * "1234" → "1.2k", "1234567" → "1.2M". Shorter than the raw number, easier
 * to scan inside a single-line thought chunk.
 */
export function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Best-effort context-window lookup for a model id. Used as the `size` field
 * on the ACP `usage_update` notification (matches the rendering
 * `Input: <used> / <size>` in clients like Zed).
 *
 * Resolution order:
 *   1. `INVOX_CONTEXT_WINDOW_<MODELID>` env (uppercased, dots/dashes/slashes
 *      → underscores). Lets users override per model — e.g. for
 *      `qwen/qwen3-coder-30b` set `INVOX_CONTEXT_WINDOW_QWEN_QWEN3_CODER_30B=131072`.
 *   2. `INVOX_CONTEXT_WINDOW_DEFAULT` env — fallback for unknown ids.
 *   3. A small built-in table for popular families (gpt-4o, deepseek, qwen, …).
 *   4. Final fallback: 128_000 (~ what most current frontier models offer;
 *      better than 0 which would make Zed render "0/0").
 *
 * Returns a u64-safe integer.
 */
export function contextWindowFor(modelId: string): number {
  // 1. Per-model env override
  const envKey = `INVOX_CONTEXT_WINDOW_${modelId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    const n = Number.parseInt(envOverride, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 2. Global default override
  const defaultEnv = process.env["INVOX_CONTEXT_WINDOW_DEFAULT"];
  if (defaultEnv) {
    const n = Number.parseInt(defaultEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 3. Built-in heuristics. Order matters — first match wins.
  const id = modelId.toLowerCase();
  for (const [pattern, size] of CONTEXT_WINDOW_TABLE) {
    if (id.includes(pattern)) return size;
  }
  // 4. Final fallback. 128k is a safe modern default that won't make Zed
  // render a meaningless `used / 0` ratio.
  return 128_000;
}

/**
 * Substring → context-window pairs. We match by substring rather than exact
 * id so user-supplied display names (e.g. "qwen/qwen3-coder-30b") still
 * resolve. Sizes are vendor-published max context for the family.
 *
 * 长期看应该外置为 JSON 配置（PROGRESS K8 / Backlog），但当前硬编码方便
 * tree-shake，且更新频率不高。
 */
const CONTEXT_WINDOW_TABLE: ReadonlyArray<readonly [string, number]> = [
  // OpenAI
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_385],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  // Anthropic (via OAI-compat proxies)
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-opus-4", 200_000],
  ["claude", 200_000],
  // Open weights — common deployments
  ["deepseek-r1", 128_000],
  ["deepseek-v3", 128_000],
  ["deepseek-coder", 128_000],
  ["deepseek", 128_000],
  ["qwen3-coder", 256_000],
  ["qwen3", 128_000],
  ["qwen2.5", 128_000],
  ["qwen", 128_000],
  ["llama-3.3", 128_000],
  ["llama-3.1", 128_000],
  ["llama", 8_192],
  // Xiaomi MiMo. v2.5 / v2.5-pro both ship 1M tokens; the older 7B-RL series
  // is 32k. Match the v2.5 family first by substring.
  ["mimo-v2.5", 1_000_000],
  ["mimo", 32_768],
  ["mistral-large", 128_000],
  ["mistral", 32_768],
  ["gemini-2", 1_000_000],
  ["gemini", 1_000_000],
];
