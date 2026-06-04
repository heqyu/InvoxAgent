// 单测：tools/fs-utils.ts 的路径工具
//
// PROGRESS A1 硬指标 ——「Windows / Git Bash 路径解析」覆盖。
//
// normalizeInputPath 在 win32 才进行转换；测 win32 行为时使用 stub 把
// process.platform 切换。posix 路径则直接 passthrough。
//
// isInsideWorkspace 测前缀边界（"workspace-extra" 不应匹配 "workspace"）和
// 跨盘场景（Windows 上 G:\ 不在 C:\ 内）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeInputPath,
  isInsideWorkspace,
} from "../../src/tools/fs-utils.js";

// ── 平台 stub helper ────────────────────────────────────────────────
//
// process.platform 是只读 getter，但可以通过 defineProperty 强制覆盖。
// 各 case 自行在 beforeEach/afterEach 中切换，避免污染其他文件。

let originalPlatform: NodeJS.Platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  originalPlatform = process.platform;
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("normalizeInputPath (POSIX)", () => {
  it("非 win32 平台不做任何转换", () => {
    setPlatform("linux");
    expect(normalizeInputPath("/d/foo/bar")).toBe("/d/foo/bar");
    expect(normalizeInputPath("/usr/local")).toBe("/usr/local");
    expect(normalizeInputPath("relative/path")).toBe("relative/path");
  });
});

describe("normalizeInputPath (Windows)", () => {
  beforeEach(() => setPlatform("win32"));

  it("Git Bash 风格 /d/foo → D:\\foo", () => {
    expect(normalizeInputPath("/d/foo/bar")).toBe("D:\\foo\\bar");
  });

  it("大写盘符同样工作（/D/foo）", () => {
    expect(normalizeInputPath("/D/foo")).toBe("D:\\foo");
  });

  it("仅盘符 /d → D:\\", () => {
    expect(normalizeInputPath("/d")).toBe("D:\\");
  });

  it("/c/Users 的常见路径", () => {
    expect(normalizeInputPath("/c/Users/Alice/repo")).toBe(
      "C:\\Users\\Alice\\repo",
    );
  });

  it("非单字母盘符前缀不应被识别（保留原样）", () => {
    expect(normalizeInputPath("/usr/local")).toBe("/usr/local");
    expect(normalizeInputPath("/foo/bar")).toBe("/foo/bar"); // foo 不是单字母
  });

  it("已经是 Windows 风格则原样返回", () => {
    expect(normalizeInputPath("D:\\foo\\bar")).toBe("D:\\foo\\bar");
  });

  it("Unix 根目录 / 不应误判为盘符", () => {
    expect(normalizeInputPath("/")).toBe("/");
  });

  it("相对路径不受影响", () => {
    expect(normalizeInputPath("foo/bar")).toBe("foo/bar");
    expect(normalizeInputPath("./foo")).toBe("./foo");
  });
});

describe("isInsideWorkspace (POSIX)", () => {
  beforeEach(() => setPlatform("linux"));

  it("精确等于工作区根：算在内", () => {
    expect(isInsideWorkspace("/repo", "/repo")).toBe(true);
  });

  it("子目录算在内", () => {
    expect(isInsideWorkspace("/repo/src/foo.ts", "/repo")).toBe(true);
  });

  it("外部路径不在内", () => {
    expect(isInsideWorkspace("/other/file", "/repo")).toBe(false);
  });

  it("前缀边界：'/repo-extra' 不应被认为在 '/repo' 内", () => {
    expect(isInsideWorkspace("/repo-extra/file", "/repo")).toBe(false);
  });

  it("尾部斜杠不影响", () => {
    expect(isInsideWorkspace("/repo/file", "/repo/")).toBe(true);
  });

  it("POSIX 大小写敏感", () => {
    expect(isInsideWorkspace("/REPO/file", "/repo")).toBe(false);
  });
});

describe("isInsideWorkspace (Windows)", () => {
  beforeEach(() => setPlatform("win32"));

  it("同盘子目录：算在内", () => {
    expect(isInsideWorkspace("G:\\repo\\src", "G:\\repo")).toBe(true);
  });

  it("跨盘绝对路径：不在内", () => {
    expect(isInsideWorkspace("C:\\foo", "G:\\repo")).toBe(false);
  });

  it("Windows 大小写不敏感（NTFS 约定）", () => {
    expect(isInsideWorkspace("G:\\REPO\\src", "g:\\repo")).toBe(true);
  });

  it("前缀边界（'G:\\repo-extra' 不应匹配 'G:\\repo'）", () => {
    expect(isInsideWorkspace("G:\\repo-extra\\file", "G:\\repo")).toBe(false);
  });
});
