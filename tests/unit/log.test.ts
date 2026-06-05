import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLogger, log } from "../../src/log.js";

// 辅助：拦截 stderr.write 输出，返回捕获到的日志行
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("createLogger", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env["INVOX_LOG"];
    delete process.env["INVOX_LOG_MODULE"];
  });

  it("输出包含 [module] 标识", () => {
    process.env["INVOX_LOG"] = "info";
    const logger = createLogger("agent");
    const lines = captureStderr(() => logger.info("hello"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[info]");
    expect(lines[0]).toContain("[agent]");
    expect(lines[0]).toContain("hello");
  });

  it("默认 log 导出的模块标识为 core", () => {
    process.env["INVOX_LOG"] = "info";
    const lines = captureStderr(() => log.info("test core"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[core]");
  });

  it("INVOX_LOG_MODULE=* → 全部通过", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "*";
    const agent = createLogger("agent");
    const tools = createLogger("tools");
    const l1 = captureStderr(() => agent.info("a"));
    const l2 = captureStderr(() => tools.info("b"));
    expect(l1.length).toBe(1);
    expect(l2.length).toBe(1);
  });

  it("INVOX_LOG_MODULE=[] → 全部静默", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "[]";
    const agent = createLogger("agent");
    const tools = createLogger("tools");
    const l1 = captureStderr(() => agent.info("a"));
    const l2 = captureStderr(() => tools.info("b"));
    expect(l1.length).toBe(0);
    expect(l2.length).toBe(0);
  });

  it("INVOX_LOG_MODULE='' (空) → 全部静默", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "";
    const agent = createLogger("agent");
    const lines = captureStderr(() => agent.info("should be silent"));
    expect(lines.length).toBe(0);
  });

  it("INVOX_LOG_MODULE=[agent,llm] → 仅 agent、llm 通过", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "agent,llm";
    const agent = createLogger("agent");
    const llm = createLogger("llm");
    const tools = createLogger("tools");
    const l1 = captureStderr(() => agent.info("a"));
    const l2 = captureStderr(() => llm.info("b"));
    const l3 = captureStderr(() => tools.info("c"));
    expect(l1.length).toBe(1);
    expect(l2.length).toBe(1);
    expect(l3.length).toBe(0);
  });

  it("INVOX_LOG_MODULE=[*,-agent] → 除了 agent 都通过", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "*,-agent";
    const agent = createLogger("agent");
    const tools = createLogger("tools");
    const llm = createLogger("llm");
    const l1 = captureStderr(() => agent.info("a"));
    const l2 = captureStderr(() => tools.info("b"));
    const l3 = captureStderr(() => llm.info("c"));
    expect(l1.length).toBe(0);
    expect(l2.length).toBe(1);
    expect(l3.length).toBe(1);
  });

  it("无 INVOX_LOG_MODULE 时默认全部通过", () => {
    process.env["INVOX_LOG"] = "info";
    delete process.env["INVOX_LOG_MODULE"];
    const agent = createLogger("agent");
    const tools = createLogger("tools");
    const l1 = captureStderr(() => agent.info("a"));
    const l2 = captureStderr(() => tools.info("b"));
    expect(l1.length).toBe(1);
    expect(l2.length).toBe(1);
  });

  it("isEnabled() 正确考虑 level + module 双重过滤", () => {
    process.env["INVOX_LOG"] = "info";
    process.env["INVOX_LOG_MODULE"] = "agent,llm";
    const agent = createLogger("agent");
    const tools = createLogger("tools");

    // agent: level info 通过，module 在白名单
    expect(agent.isEnabled("info")).toBe(true);
    // agent: level trace 超出 info → false
    expect(agent.isEnabled("trace")).toBe(false);
    // tools: level info 通过，但 module 不在白名单 → false
    expect(tools.isEnabled("info")).toBe(false);
    // tools: level trace 超出且 module 不在白名单 → false
    expect(tools.isEnabled("trace")).toBe(false);
  });

  it("isEnabled() 无 INVOX_LOG_MODULE 时仅按 level 判断", () => {
    process.env["INVOX_LOG"] = "warn";
    delete process.env["INVOX_LOG_MODULE"];
    const agent = createLogger("agent");

    expect(agent.isEnabled("error")).toBe(true);
    expect(agent.isEnabled("warn")).toBe(true);
    expect(agent.isEnabled("info")).toBe(false);
    expect(agent.isEnabled("debug")).toBe(false);
  });
});
