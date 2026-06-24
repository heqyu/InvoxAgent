// Provider 选择函数 —— 从 cli.ts 抽出（J2.5）。
//
// 正式 provider / model 菜单由 providers.json 驱动；本文件只负责根据
// INVOX_MOCK 选择离线 mock provider。

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
