// Token 渲染与 context window 推断 —— reportTurnUsage 的纯渲染依赖。

/**
 * 按 Zed token-meter 风格渲染整数：1234 → "1.2k"，1234567 → "1.2M"。
 * 比裸数字短，单行 thought chunk 里更易读。
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
 * 按 model id 推断 context window 大小，用于 ACP `usage_update` 的 size
 * 字段（Zed 渲染成 "Input: <used> / <size>"）。
 *
 * 解析顺序：
 *   1. `INVOX_CONTEXT_WINDOW_<MODELID>` —— 大写化、非字母数字转下划线。
 *      例：模型 `qwen/qwen3-coder-30b` 对应 `INVOX_CONTEXT_WINDOW_QWEN_QWEN3_CODER_30B`
 *   2. `INVOX_CONTEXT_WINDOW_DEFAULT` —— 未匹配模型时的全局兜底
 *   3. 内置常见模型族表（gpt-4o / deepseek / qwen / claude / ...）
 *   4. 终极兜底 128_000 —— 现代 frontier 模型的常见容量，避免 Zed 渲染 "0/0"
 */
export function contextWindowFor(modelId: string): number {
  // 1. per-model env 覆盖
  const envKey = `INVOX_CONTEXT_WINDOW_${modelId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    const n = Number.parseInt(envOverride, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 2. 全局兜底 env 覆盖
  const defaultEnv = process.env["INVOX_CONTEXT_WINDOW_DEFAULT"];
  if (defaultEnv) {
    const n = Number.parseInt(defaultEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 3. 内置启发式表 —— 顺序敏感，第一个 substring 命中即返回
  const id = modelId.toLowerCase();
  for (const [pattern, size] of CONTEXT_WINDOW_TABLE) {
    if (id.includes(pattern)) return size;
  }
  // 4. 终极兜底
  return 128_000;
}

/**
 * 子串 → context-window 的对照表。用 substring 匹配（不要求精确等于），
 * 便于支持 "qwen/qwen3-coder-30b" 这种带前缀的展示名。
 * 容量取自厂商公布的同族最大值。
 *
 * 后续可外置为 JSON 配置；当前硬编码方便 tree-shake，且更新频率不高。
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
  // Anthropic（通过 OAI 兼容代理）
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-opus-4", 200_000],
  ["claude", 200_000],
  // 开源权重 —— 常见部署
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
  // 小米 MiMo：v2.5 / v2.5-pro 都是 1M tokens；老的 7B-RL 系列是 32k。
  // 子串顺序保证 v2.5 优先匹配。
  ["mimo-v2.5", 1_000_000],
  ["mimo", 32_768],
  ["mistral-large", 128_000],
  ["mistral", 32_768],
  ["gemini-2", 1_000_000],
  ["gemini", 1_000_000],
];
