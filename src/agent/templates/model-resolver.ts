import { createLogger } from "../../log.js";
const log = createLogger("templates");

// ── model 字段解析 ────────────────────────────────────────────────────

/**
 * `INVOX_MODEL_PRO` / `INVOX_MODEL_LITE` 这两个 invox 一等环境变量 ——
 *
 *   - PRO  : 高度推理 / 规划任务推荐用的"专业"model id
 *   - LITE : 只负责干活、按既定计划执行的"轻量"model id
 *
 * agent.model = "$MODEL_PRO" / "$MODEL_LITE" 占位符会被解析到对应实际值。
 * 用户也可以在 INVOX_MODELS 里直接列出这两个 id —— 但 cli.ts 启动时会
 * 自动把它们并入 available 列表，无须手动重复。
 *
 * 别名兼容：解析时先看带 INVOX_ 前缀的标准变量，回退到不带前缀的别名
 * （MODEL_PRO / MODEL_LITE），方便 docker-compose 等场景直接使用短名。
 */
export const MODEL_PRO_ENV_PRIMARY = "INVOX_MODEL_PRO";
export const MODEL_LITE_ENV_PRIMARY = "INVOX_MODEL_LITE";
export const MODEL_PRO_ENV_ALIAS = "MODEL_PRO";
export const MODEL_LITE_ENV_ALIAS = "MODEL_LITE";

/**
 * 读取 INVOX_MODEL_PRO 的实际值（先标准名再 alias）。
 * 都未设置返回 undefined。空字符串视为未设，触发别名回退。
 */
export function readEnvModelPro(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const primary = env[MODEL_PRO_ENV_PRIMARY];
  if (primary && primary.length > 0) return primary;
  const alias = env[MODEL_PRO_ENV_ALIAS];
  if (alias && alias.length > 0) return alias;
  return undefined;
}

/**
 * 读取 INVOX_MODEL_LITE 的实际值（先标准名再 alias）。
 * 都未设置返回 undefined。空字符串视为未设，触发别名回退。
 */
export function readEnvModelLite(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const primary = env[MODEL_LITE_ENV_PRIMARY];
  if (primary && primary.length > 0) return primary;
  const alias = env[MODEL_LITE_ENV_ALIAS];
  if (alias && alias.length > 0) return alias;
  return undefined;
}

/**
 * 把 agent.model 字段解析为实际 model id。
 *
 * 规则（按出现顺序匹配）：
 *   1. modelField 未设   → 返回 fallback
 *   2. 不以 "$" 开头     → 当作具体 id 直接返回（"gpt-4o" / "qwen3-coder-30b" 等）
 *   3. "$MODEL_PRO"      → INVOX_MODEL_PRO || MODEL_PRO，都无 → warn + fallback
 *   4. "$MODEL_LITE"     → INVOX_MODEL_LITE || MODEL_LITE，都无 → warn + fallback
 *   5. "$XXX"            → process.env.XXX（通用），未设 → warn + fallback
 *
 * **永不抛错**：解析失败一律 warn 后回退到 fallback，让 agent 切换流畅
 * （用户视角：模型没切到？查日志，不要让请求层挂掉）。
 */
export function resolveAgentModel(
  modelField: string | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!modelField || modelField.length === 0) return fallback;
  if (!modelField.startsWith("$")) return modelField;

  const varName = modelField.slice(1);
  if (varName === MODEL_PRO_ENV_ALIAS) {
    const v = readEnvModelPro(env);
    if (v) return v;
    log.warn("agent model: $MODEL_PRO unresolved, falling back", {
      modelField,
      fallback,
      envChecked: [MODEL_PRO_ENV_PRIMARY, MODEL_PRO_ENV_ALIAS],
    });
    return fallback;
  }
  if (varName === MODEL_LITE_ENV_ALIAS) {
    const v = readEnvModelLite(env);
    if (v) return v;
    log.warn("agent model: $MODEL_LITE unresolved, falling back", {
      modelField,
      fallback,
      envChecked: [MODEL_LITE_ENV_PRIMARY, MODEL_LITE_ENV_ALIAS],
    });
    return fallback;
  }

  // 通用 env 引用：$XXX → process.env.XXX
  const v = env[varName];
  if (v && v.length > 0) return v;
  log.warn("agent model: env var unresolved, falling back", {
    modelField,
    var: varName,
    fallback,
  });
  return fallback;
}
