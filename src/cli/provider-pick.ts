// Provider / model 选择函数 —— 从 cli.ts 抽出（J2.5）。
//
// pickMockProvider / pickLegacyModels 负责根据环境变量选择离线 mock provider
// 和构造 model 菜单。正式 provider 由 cli.ts 通过 providers.json 加载。

import { readEnvModelLite, readEnvModelPro } from "../agent/templates/index.js";
import type { AgentModelConfig, ModelInfo } from "../agent/session-types.js";
import { EchoProvider } from "../llm/echo.js";
import { FlakyProvider, type FlakyKind } from "../llm/flaky.js";
import { BadJsonProvider, MockToolProvider } from "../llm/mock-tools.js";
import type { LLMProvider } from "../llm/types.js";
import { createLogger } from "../log.js";

const log = createLogger("cli");

/**
 * 从 INVOX_MOCK 环境变量选取离线 mock provider。
 * 未设 INVOX_MOCK 或值不匹配时返回 null（调用方继续走正常路径）。
 */
export function pickMockProvider(): LLMProvider | null {
  const mock = process.env["INVOX_MOCK"];
  if (mock === "tools") {
    log.info("provider: mock-tools (INVOX_MOCK=tools)");
    return new MockToolProvider();
  }
  if (mock === "bad-json") {
    log.info("provider: mock-bad-json (INVOX_MOCK=bad-json)");
    return new BadJsonProvider();
  }
  if (mock === "flaky") {
    const kind = (process.env["INVOX_FLAKY_KIND"] ?? "429") as FlakyKind;
    log.info("provider: mock-flaky", { kind });
    return new FlakyProvider(kind);
  }
  if (mock === "1") {
    log.info("provider: echo (INVOX_MOCK=1)");
    return new EchoProvider();
  }
  return null;
}

/**
 * Legacy model 菜单构造（仅在非 multi-provider 模式下使用）。
 *
 * 来源（优先级从高到低）：
 *   - INVOX_MODELS=id1,id2,id3  —— 用户自定义列表
 *   - INVOX_MODEL                —— 唯一 / 默认条目兜底
 *   - 写死 "gpt-4o-mini"          —— 终极兜底，保证菜单非空
 *
 * 规则：默认 model **永远**出现在菜单里（不在则被 unshift 到首位）。
 * Phase H：INVOX_MODEL_PRO / INVOX_MODEL_LITE 解析后的实际值自动并入。
 */
export function pickLegacyModels(): AgentModelConfig {
  const fallback = process.env["INVOX_MODEL"] ?? "gpt-4o-mini";
  const raw = process.env["INVOX_MODELS"] ?? fallback;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!ids.includes(fallback)) ids.unshift(fallback);

  // INVOX_MODEL_PRO / INVOX_MODEL_LITE：作为 agent.model 占位符引用的目标，
  // 把它们解析后的实际 id 也并入 menu。
  const proId = readEnvModelPro();
  if (proId && !ids.includes(proId)) ids.push(proId);
  const liteId = readEnvModelLite();
  if (liteId && !ids.includes(liteId)) ids.push(liteId);

  const available: ModelInfo[] = ids.map((id) => ({ modelId: id, name: id }));
  return { available, defaultModelId: fallback };
}
