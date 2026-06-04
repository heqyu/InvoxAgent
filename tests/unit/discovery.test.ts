// 单测：discovery/index.ts 三层（user / project / plugin）配置解析
//
// PROGRESS A1 硬指标 ——「discovery 三层合并、settings.json / plugins.json 解析」覆盖。
//
// 测试策略：
//   1. 在 OS 临时目录下建立一个「假 home」和「假 cwd」，分别放 .claude/ 配置
//   2. vi.mock("node:os") 把 homedir() 指向假 home
//   3. 每个 case 调用前 clearDiscoveryCache —— 否则 cache 命中会跨 case 串味
//
// 范围：discoverDirs 的解析与合并；hook 命令执行另文件覆盖。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// homedir() 的 mock 必须在 import discoverDirs 之前 hoist —— vi.mock 自动 hoist。
// 这里返回的 fakeHome 在每个 case 里覆盖（通过 mockImplementation）。
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

import {
  discoverDirs,
  clearDiscoveryCache,
} from "../../src/discovery/index.js";

// ── 临时目录构建 helper ───────────────────────────────────────────

interface FakeEnv {
  home: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "invox-discovery-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    cwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

// ── 测试 ─────────────────────────────────────────────────────────────

describe("discoverDirs", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
    clearDiscoveryCache();
  });

  afterEach(() => {
    env.cleanup();
    clearDiscoveryCache();
  });

  describe("基本路径解析", () => {
    it("两个目录都不存在时仍返回结构化结果", () => {
      const r = discoverDirs(env.cwd);
      expect(r.userDir).toBe(join(env.home, ".claude"));
      expect(r.projectDir).toBe(join(env.cwd, ".claude"));
      expect(r.userSettings).toBeNull();
      expect(r.projectSettings).toBeNull();
      expect(r.plugins).toEqual([]);
      expect(r.memories).toEqual([]);
    });
  });

  describe("settings.json 加载", () => {
    it("仅 user 有 settings.json", () => {
      writeJson(join(env.home, ".claude", "settings.json"), {
        hooks: { SessionStart: [] },
      });
      const r = discoverDirs(env.cwd);
      expect(r.userSettings).not.toBeNull();
      expect(r.userSettings?.hooks).toBeDefined();
      expect(r.projectSettings).toBeNull();
    });

    it("仅 project 有 settings.json", () => {
      writeJson(join(env.cwd, ".claude", "settings.json"), { foo: "bar" });
      const r = discoverDirs(env.cwd);
      expect(r.userSettings).toBeNull();
      expect(r.projectSettings).toEqual({ foo: "bar" });
    });

    it("两个 settings.json 都存在 —— 都返回（合并由消费者决定）", () => {
      writeJson(join(env.home, ".claude", "settings.json"), { source: "user" });
      writeJson(join(env.cwd, ".claude", "settings.json"), {
        source: "project",
      });
      const r = discoverDirs(env.cwd);
      expect(r.userSettings).toEqual({ source: "user" });
      expect(r.projectSettings).toEqual({ source: "project" });
    });

    it("非法 JSON 应静默忽略（warn-log），返回 null", () => {
      mkdirSync(join(env.home, ".claude"), { recursive: true });
      writeFileSync(
        join(env.home, ".claude", "settings.json"),
        "{not-json:::",
        "utf8",
      );
      const r = discoverDirs(env.cwd);
      expect(r.userSettings).toBeNull();
    });

    it("settings.json 是数组（非对象）应被拒绝", () => {
      mkdirSync(join(env.home, ".claude"), { recursive: true });
      writeFileSync(
        join(env.home, ".claude", "settings.json"),
        JSON.stringify([1, 2, 3]),
        "utf8",
      );
      const r = discoverDirs(env.cwd);
      expect(r.userSettings).toBeNull();
    });
  });

  describe("plugins.json 加载（first-found-wins）", () => {
    it("project plugins.json 存在则忽略 user 的", () => {
      writeJson(join(env.home, ".claude", "plugins.json"), [
        { path: "/abs/user-plugin" },
      ]);
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        { path: "/abs/project-plugin" },
      ]);
      const r = discoverDirs(env.cwd);
      expect(r.plugins).toHaveLength(1);
      expect(r.plugins[0]?.root).toBe("/abs/project-plugin");
    });

    it("仅 user 有 plugins.json 则使用之", () => {
      writeJson(join(env.home, ".claude", "plugins.json"), [
        { path: "/abs/user-plugin" },
      ]);
      const r = discoverDirs(env.cwd);
      expect(r.plugins).toHaveLength(1);
      expect(r.plugins[0]?.root).toBe("/abs/user-plugin");
    });

    it("相对路径解析：user → 相对 ~/，project → 相对 cwd", () => {
      writeJson(join(env.home, ".claude", "plugins.json"), [
        { path: "rel-from-home" }, // user 级 — basePath = home
      ]);
      const r1 = discoverDirs(env.cwd);
      expect(r1.plugins[0]?.root).toBe(join(env.home, "rel-from-home"));

      // 切到一个新 cwd 测 project 级别相对解析
      clearDiscoveryCache();
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        { path: "rel-from-cwd" },
      ]);
      const r2 = discoverDirs(env.cwd);
      expect(r2.plugins[0]?.root).toBe(join(env.cwd, "rel-from-cwd"));
    });

    it("enabled:false 被保留但标记为禁用", () => {
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        { path: "/abs/p1", enabled: false },
        { path: "/abs/p2" },
      ]);
      const r = discoverDirs(env.cwd);
      expect(r.plugins).toHaveLength(2);
      expect(r.plugins[0]?.enabled).toBe(false);
      expect(r.plugins[1]?.enabled).toBe(true); // 默认 true
    });

    it("缺 path 字段的 entry 被丢弃", () => {
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        { name: "no-path" },
        { path: "/abs/ok" },
      ]);
      const r = discoverDirs(env.cwd);
      expect(r.plugins).toHaveLength(1);
      expect(r.plugins[0]?.root).toBe("/abs/ok");
    });

    it("非数组的 plugins.json 视为无效", () => {
      writeJson(join(env.cwd, ".claude", "plugins.json"), {
        not: "an array",
      });
      const r = discoverDirs(env.cwd);
      expect(r.plugins).toEqual([]);
    });

    it("skills 字段透传，用于后续 per-skill 开关", () => {
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        {
          path: "/abs/p",
          skills: { "skill-a": true, "skill-b": false },
        },
      ]);
      const r = discoverDirs(env.cwd);
      expect(r.plugins[0]?.skills).toEqual({
        "skill-a": true,
        "skill-b": false,
      });
    });
  });

  describe("缓存语义", () => {
    it("同一 cwd 的两次调用返回同一引用（避免 IO）", () => {
      const r1 = discoverDirs(env.cwd);
      const r2 = discoverDirs(env.cwd);
      expect(r1).toBe(r2);
    });

    it("clearDiscoveryCache(cwd) 仅清除指定 cwd", () => {
      const r1 = discoverDirs(env.cwd);
      clearDiscoveryCache(env.cwd);
      const r2 = discoverDirs(env.cwd);
      expect(r1).not.toBe(r2);
    });

    it("clearDiscoveryCache() 不传参清除全部", () => {
      const r1 = discoverDirs(env.cwd);
      clearDiscoveryCache();
      const r2 = discoverDirs(env.cwd);
      expect(r1).not.toBe(r2);
    });
  });

  // memories 字段：CLAUDE.md provider 是当前唯一内置的 MemoryProvider，
  // 详细 @reference 解析、broken reference 等行为由 claude-md.test.ts 通过
  // shim API 覆盖；这里只验证 discovery 层面的契约 —— memories 字段确实被
  // 填充、按 priority 排序、和缓存语义一致。
  describe("memories 字段（CLAUDE.md provider）", () => {
    it("两级目录都没有 CLAUDE.md 时为空数组", () => {
      const r = discoverDirs(env.cwd);
      expect(r.memories).toEqual([]);
    });

    it("user + project 都有 CLAUDE.md → 两条，按 priority 升序（user=10 在 project=20 前）", () => {
      mkdirSync(join(env.home, ".claude"), { recursive: true });
      mkdirSync(join(env.cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(env.home, ".claude", "CLAUDE.md"),
        "user level memory",
        "utf8",
      );
      writeFileSync(
        join(env.cwd, ".claude", "CLAUDE.md"),
        "project level memory",
        "utf8",
      );
      const r = discoverDirs(env.cwd);
      expect(r.memories).toHaveLength(2);
      expect(r.memories[0]?.provider).toBe("claude-md");
      expect(r.memories[0]?.source).toBe("user");
      expect(r.memories[0]?.priority).toBe(10);
      expect(r.memories[0]?.origin).toBe(
        join(env.home, ".claude", "CLAUDE.md"),
      );
      expect(r.memories[1]?.source).toBe("project");
      expect(r.memories[1]?.priority).toBe(20);
    });

    it("memories 与 plugins / settings 共存于同一份缓存（同 cwd 同引用）", () => {
      mkdirSync(join(env.cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(env.cwd, ".claude", "CLAUDE.md"),
        "project memory",
        "utf8",
      );
      writeJson(join(env.cwd, ".claude", "plugins.json"), [
        { path: "/abs/p" },
      ]);
      const r1 = discoverDirs(env.cwd);
      const r2 = discoverDirs(env.cwd);
      expect(r1.memories).toBe(r2.memories);
      expect(r1.plugins).toBe(r2.plugins);
    });

    it("仅 project 有 CLAUDE.md → 一条 project section", () => {
      mkdirSync(join(env.cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(env.cwd, ".claude", "CLAUDE.md"),
        "project only",
        "utf8",
      );
      const r = discoverDirs(env.cwd);
      expect(r.memories).toHaveLength(1);
      expect(r.memories[0]?.source).toBe("project");
      expect(r.memories[0]?.content).toContain("project only");
    });
  });
});
