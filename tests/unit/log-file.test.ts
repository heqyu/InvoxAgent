// 单测：log.ts —— openSessionLogFile
//
// J1.1 / J1.3 新增。验证日志文件写入 + fileNameFn 自定义路径 + mkdir 失败兜底。

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSessionLogFile } from "../../src/log.js";

let testDir: string;

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("openSessionLogFile", () => {
  it("默认：写到 <cwd>/.invox/logs/<name>.log", () => {
    testDir = join(tmpdir(), `invox-log-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const logFile = openSessionLogFile(testDir, "abc123", "session");
    expect(logFile.path).toBe(join(testDir, ".invox", "logs", "abc123.log"));

    logFile.write("hello world");
    logFile.close();

    const content = readFileSync(logFile.path, "utf-8");
    expect(content).toContain("hello world");
  });

  it("传 fileNameFn 时文件名走自定义路径", () => {
    testDir = join(tmpdir(), `invox-log-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const logFile = openSessionLogFile(testDir, "parentId", "subagent", {
      fileNameFn: (base) => `subagent-${base.slice(0, 8)}-run1-2026`,
    });
    expect(logFile.path).toContain("subagent-parentId-run1-2026.log");

    logFile.write("subagent output");
    logFile.close();

    const content = readFileSync(logFile.path, "utf-8");
    expect(content).toContain("subagent output");
  });

  it("mkdir 失败时返回 noop（不抛错）", () => {
    // 传一个不可能创建子目录的路径（文件路径而非目录）
    testDir = join(tmpdir(), `invox-log-impossible-${Date.now()}`);
    // 创建一个文件，让它不能作为 mkdir 的父目录
    writeFileSync(testDir, "i am a file");

    const logFile = openSessionLogFile(testDir, "abc", "session");
    // noop log: path should be empty, write/close should not throw
    expect(logFile.path).toBe("");
    expect(() => logFile.write("test")).not.toThrow();
    expect(() => logFile.close()).not.toThrow();
  });

  it("文件名 sanitize：特殊字符被替换为 _", () => {
    testDir = join(tmpdir(), `invox-log-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const logFile = openSessionLogFile(testDir, "abc/def!@#", "session");
    expect(logFile.path).toContain("abc_def___.log");
    logFile.close();
  });
});
