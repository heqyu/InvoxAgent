import type { AgentModelsConfig } from "../../llm/providers.js";
import { createLogger } from "../../log.js";
const log = createLogger("templates");

// ── model 字段解析 ────────────────────────────────────────────────────

/**
 * `"$MODEL_PRO"` / `"$MODEL_LITE"` 占位符的解析规则：
 *
 *   1. providers.json 的 `agentModels.PRO` / `agentModels.LITE` 为主来源
 *   2. 环境变量 `INVOX_MODEL_PRO` / `INVOX_MODEL_LITE`（或别名 `MODEL_PRO` / `MODEL_LITE`）为兜底
 *   3. 都未设 → warn + 回退到 fallback
 *
 * 其他 `$XXX` 占位符直接查 `process.env.XXX`。
 */
const MODEL_PRO_ALIAS = "MODEL_PRO";
const MODEL_LITE_ALIAS = "MODEL_LITE";

/**
 * 读取 INVOX_MODEL_PRO 的实际值（先标准名再 alias）。
 * 都未设置返回 undefined。空字符串视为未设，触发别名回退。
 * 仅供 `resolveAgentModel` 内部 fallback 使用。
 */
function readEnvModelPro(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const primary = env["INVOX_MODEL_PRO"];
  if (primary && primary.length > 0) return primary;
  const alias = env[MODEL_PRO_ALIAS];
  if (alias && alias.length > 0) return alias;
  return undefined;
}

/**
 * 读取 INVOX_MODEL_LITE 的实际值（先标准名再 alias）。
 * 都未设置返回 undefined。空字符串视为未设，触发别名回退。
 * 仅供 `resolveAgentModel` 内部 fallback 使用。
 */
function readEnvModelLite(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const primary = env["INVOX_MODEL_LITE"];
  if (primary && primary.length > 0) return primary;
  const alias = env[MODEL_LITE_ALIAS];
  if (alias && alias.length > 0) return alias;
  return undefined;
}

/**
 * 把 agent.model 字段解析为实际 model id。
 *
 * 规则（按出现顺序匹配）：
 *   1. modelField 未设     → 返回 fallback
 *   2. 不以 "$" 开头       → 当作具体 id 直接返回（"gpt-4o" / "qwen3-coder-30b" 等）
 *   3. "$MODEL_PRO"        → agentModels.PRO → env fallback → warn + fallback
 *   4. "$MODEL_LITE"       → agentModels.LITE → env fallback → warn + fallback
 *   5. "$XXX"              → process.env.XXX（通用），未设 → warn + fallback
 *
 * **永不抛错**：解析失败一律 warn 后回退到 fallback，让 agent 切换流畅
 * （用户视角：模型没切到？查日志，不要让请求层挂掉）。
 */
export function resolveAgentModel(
  modelField: string | undefined,
  fallback: string,
  agentModels?: AgentModelsConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!modelField || modelField.length === 0) return fallback;
  if (!modelField.startsWith("$")) return modelField;

  const varName = modelField.slice(1);
  if (varName === MODEL_PRO_ALIAS) {
    // providers.json agentModels.PRO 为主来源
    if (agentModels?.PRO) return agentModels.PRO;
    // env 兜底
    const v = readEnvModelPro(env);
    if (v) return v;
    log.warn("agent model: $MODEL_PRO unresolved, falling back", {
      modelField,
      fallback,
    });
    return fallback;
  }
  if (varName === MODEL_LITE_ALIAS) {
    // providers.json agentModels.LITE 为主来源
    if (agentModels?.LITE) return agentModels.LITE;
    // env 兜底
    const v = readEnvModelLite(env);
    if (v) return v;
    log.warn("agent model: $MODEL_LITE unresolved, falling back", {
      modelField,
      fallback,
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
