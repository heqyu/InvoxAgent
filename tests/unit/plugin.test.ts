// 单测：plugins/loader.ts —— Plugin skill 加载、过滤与 project 覆盖
//
// PROGRESS A1 硬指标 ——「plugin 技能开关与 project 覆盖」覆盖。
// 范围：plugin skill 加载、disabled plugin、disabled skill、project override。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 homedir
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { executeTool } from "../../src/tools/router.js";
import { FileCache } from "../../src/tools/cache.js";
import { getTool } from "../../src/tools/registry.js";
import { clearPluginCache } from "../../src/plugins/loader.js";
import { clearDiscoveryCache } from "../../src/discovery/index.js";
import type { ToolExecContext, SessionToolState } from "../../src/tools/types.js";

// ── helpers ───────────────────────────────────────────────────────────

interface FakeEnv {
  root: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "invox-plugin-test-"));
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  return { root, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 创建插件目录含 plugin.json + skill SKILL.md */
function createPlugin(
  cwd: string,
  name: string,
  skillNames: string[],
): string {
  const pluginDir = join(cwd, "plugins", name);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0" }),
    "utf8",
  );
  for (const sk of skillNames) {
    mkdirSync(join(pluginDir, "skills", sk), { recursive: true });
    writeFileSync(
      join(pluginDir, "skills", sk, "SKILL.md"),
      `${sk}: do $ARGUMENTS.`,
      "utf8",
    );
  }
  return pluginDir;
}

/** 写 .claude/plugins.json */
function writePlugins(env: FakeEnv, entries: object[]): void {
  writeFileSync(
    join(env.cwd, ".claude", "plugins.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

function makeCtx(cwd: string): ToolExecContext {
  const state: SessionToolState = {
    readPaths: new Set(),
    cache: new FileCache(),
  };
  return {
    conn: null as never,
    sessionId: "test",
    cwd,
    caps: {},
    signal: new AbortController().signal,
    policy: "never",
    toolCallId: "test",
    state,
  };
}

async function listSkills(cwd: string): Promise<string> {
  const r = await executeTool(
    "Skill",
    JSON.stringify({ name: "list", description: "List" }),
    makeCtx(cwd),
  );
  return r.resultText;
}

// ── 测试 ──────────────────────────────────────────────────────────────

describe("plugin skills", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.root;
    clearDiscoveryCache();
    clearPluginCache();
  });

  afterEach(() => {
    clearDiscoveryCache();
    clearPluginCache();
    env.cleanup();
  });

  it("plugin skill 加载并在 Skill('list') 中显示", async () => {
    const p = createPlugin(env.cwd, "plugin-alpha", ["greet", "analyze"]);
    writePlugins(env, [{ path: p, enabled: true }]);

    const text = await listSkills(env.cwd);
    expect(text).toContain("greet");
    expect(text).toContain("analyze");
  });

  it("disabled plugin（enabled:false）的 skill 不显示", async () => {
    const p = createPlugin(env.cwd, "plugin-gamma", ["hidden"]);
    writePlugins(env, [{ path: p, enabled: false }]);

    const text = await listSkills(env.cwd);
    expect(text).not.toContain("hidden");
  });

  it("per-skill disabled（skills.xxx:false）不显示该 skill", async () => {
    const p = createPlugin(env.cwd, "plugin-alpha", ["greet", "analyze"]);
    writePlugins(env, [{ path: p, enabled: true, skills: { analyze: false } }]);

    const text = await listSkills(env.cwd);
    expect(text).toContain("greet");
    expect(text).not.toContain("analyze");
  });

  it("project-level skill 覆盖同名 plugin skill", async () => {
    const p = createPlugin(env.cwd, "plugin-alpha", ["greet"]);
    writePlugins(env, [{ path: p, enabled: true }]);

    // project override
    const projectSkills = join(env.cwd, ".claude", "skills", "greet");
    mkdirSync(projectSkills, { recursive: true });
    writeFileSync(
      join(projectSkills, "SKILL.md"),
      "PROJECT OVERRIDE: Greet $ARGUMENTS formally.",
      "utf8",
    );

    clearPluginCache();
    clearDiscoveryCache();

    const text = await listSkills(env.cwd);
    expect(text).toContain("greet");

    // 调用 greet — 应走 project 而非 plugin
    const greet = await executeTool(
      "Skill",
      JSON.stringify({
        name: "greet",
        description: "Greet",
        params: { arguments: "World" },
      }),
      makeCtx(env.cwd),
    );
    expect(greet.ok).toBe(true);
    expect(greet.resultText).toContain("PROJECT OVERRIDE");
  });

  it("多个 plugin 的 skill 全部出现在目录", async () => {
    const p1 = createPlugin(env.cwd, "plugin-one", ["a"]);
    const p2 = createPlugin(env.cwd, "plugin-two", ["b", "c"]);
    writePlugins(env, [
      { path: p1, enabled: true },
      { path: p2, enabled: true },
    ]);

    const text = await listSkills(env.cwd);
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("c");
  });

  it("plugin skill 实际执行正确（interpolate $ARGUMENTS）", async () => {
    const p = createPlugin(env.cwd, "plugin-beta", ["translate"]);
    writePlugins(env, [{ path: p, enabled: true }]);

    const result = await executeTool(
      "Skill",
      JSON.stringify({
        name: "translate",
        description: "Translate",
        params: { arguments: "hello" },
      }),
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(true);
    expect(result.resultText).toContain("hello");
  });
});
