// 单测：discovery/claude-md.ts —— CLAUDE.md 加载与 @reference 解析
//
// PROGRESS A1 硬指标 ——「CLAUDE.md @reference 解析」覆盖。
// 范围：双层加载、@resolution、缓存、空文件、broken reference。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// homedir mock（隔离真实用户 CLAUDE.md）
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  loadClaudeMd,
  clearClaudeMdCache,
} from "../../src/discovery/claude-md.js";
import { clearDiscoveryCache } from "../../src/discovery/index.js";

// ── helpers ───────────────────────────────────────────────────────────

interface FakeEnv {
  root: string;
  home: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "invox-claudemd-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  return {
    root,
    home,
    cwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ── 测试 ──────────────────────────────────────────────────────────────

describe("loadClaudeMd", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
    clearClaudeMdCache();
    clearDiscoveryCache();
  });

  afterEach(() => {
    clearClaudeMdCache();
    clearDiscoveryCache();
    env.cleanup();
  });

  it("两个 CLAUDE.md 都存在时返回 user + project 两个 section", () => {
    writeFileSync(
      join(env.home, ".claude", "CLAUDE.md"),
      "## User Preferences\n- Use python3",
      "utf8",
    );
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "## Project Rules\n- Use conventional commits",
      "utf8",
    );

    const sections = loadClaudeMd(env.cwd);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.source).toBe("user");
    expect(sections[1]!.source).toBe("project");
  });

  it("user section 内容包含原始文本", () => {
    writeFileSync(
      join(env.home, ".claude", "CLAUDE.md"),
      "## User Preferences\n- Use python3",
      "utf8",
    );
    const sections = loadClaudeMd(env.cwd);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain("User Preferences");
    expect(sections[0]!.content).toContain("python3");
  });

  it("project section 内容包含项目规则", () => {
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "## Project Rules\n- Run tests",
      "utf8",
    );
    const sections = loadClaudeMd(env.cwd);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain("Project Rules");
    expect(sections[0]!.content).toContain("Run tests");
  });

  it("@reference 被内联解析", () => {
    writeFileSync(
      join(env.home, ".claude", "RTK.md"),
      "# RTK Reference\nUse `rtk` for dev commands.",
      "utf8",
    );
    writeFileSync(
      join(env.home, ".claude", "CLAUDE.md"),
      "## User Preferences\n- Use python3\n\n@RTK.md",
      "utf8",
    );
    const sections = loadClaudeMd(env.cwd);
    expect(sections).toHaveLength(1);
    const content = sections[0]!.content;
    expect(content).toContain("User Preferences");
    expect(content).toContain("RTK Reference");
    expect(content).toContain("rtk");
    expect(content).not.toContain("@RTK.md");
  });

  it("broken @reference 标注 [file not found]", () => {
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "Some text\n\n@nonexistent.md\n\nMore text",
      "utf8",
    );
    const sections = loadClaudeMd(env.cwd);
    expect(sections).toHaveLength(1);
    const content = sections[0]!.content;
    expect(content).toContain("Some text");
    expect(content).toContain("More text");
    expect(content).toContain("[file not found]");
  });

  it("无 CLAUDE.md 返回空数组", () => {
    const emptyDir = join(tmpdir(), `invox-claudemd-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      clearClaudeMdCache(emptyDir);
      clearDiscoveryCache(emptyDir);
      const sections = loadClaudeMd(emptyDir);
      expect(sections).toHaveLength(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("仅 user-level (project 没有)", () => {
    writeFileSync(
      join(env.home, ".claude", "CLAUDE.md"),
      "## User level only",
      "utf8",
    );
    const userOnlyDir = join(tmpdir(), `invox-claudemd-useronly-${Date.now()}`);
    mkdirSync(userOnlyDir, { recursive: true });
    try {
      clearClaudeMdCache(userOnlyDir);
      clearDiscoveryCache(userOnlyDir);
      const sections = loadClaudeMd(userOnlyDir);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.source).toBe("user");
    } finally {
      rmSync(userOnlyDir, { recursive: true, force: true });
    }
  });

  it("缓存语义：同一 cwd 两次调用返回同一引用", () => {
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "# Project",
      "utf8",
    );
    const r1 = loadClaudeMd(env.cwd);
    const r2 = loadClaudeMd(env.cwd);
    expect(r1).toBe(r2);
  });

  it("clearClaudeMdCache(cwd) 使缓存失效", () => {
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "# Project",
      "utf8",
    );
    const r1 = loadClaudeMd(env.cwd);
    clearClaudeMdCache(env.cwd);
    const r2 = loadClaudeMd(env.cwd);
    expect(r1).not.toBe(r2);
  });

  it("clearClaudeMdCache() 不传参数清空全部", () => {
    writeFileSync(
      join(env.cwd, ".claude", "CLAUDE.md"),
      "# Project",
      "utf8",
    );
    const r1 = loadClaudeMd(env.cwd);
    clearClaudeMdCache();
    const r2 = loadClaudeMd(env.cwd);
    expect(r1).not.toBe(r2);
  });
});
