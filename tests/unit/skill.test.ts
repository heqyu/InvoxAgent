// 单测：tools/skill.ts —— Skill 工具的 execute、interpolate、catalog
//
// PROGRESS A1 硬指标 ——「Skill 工具 invoke」覆盖。
// 范围：list、interpolate、unknown skill、missing name、empty 项目。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 homedir 避免 ~/.claude/skills/ 干扰
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { executeTool } from "../../src/tools/router.js";
import { FileCache } from "../../src/tools/cache.js";
import { getTool, TOOL_SPECS } from "../../src/tools/registry.js";
import type { ToolExecContext, SessionToolState } from "../../src/tools/types.js";

// ── helpers ───────────────────────────────────────────────────────────

interface FakeEnv {
  root: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): { root: string; cwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "invox-skill-test-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 在 cwd/.claude/skills/<name>/ 下创建 SKILL.md */
function createSkill(cwd: string, name: string, content: string): void {
  const dir = join(cwd, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
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

// ── 测试 ──────────────────────────────────────────────────────────────

describe("Skill tool", () => {
  let env: ReturnType<typeof makeFakeEnv>;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.root;
  });

  afterEach(() => {
    env.cleanup();
  });

  it("Skill 在 TOOL_SPECS 中注册", () => {
    const spec = TOOL_SPECS.find((s) => s.function.name === "Skill");
    expect(spec).toBeDefined();
    expect(getTool("Skill")).toBeDefined();
    expect(getTool("Skill")!.tier).toBe("read");
  });

  it("Skill('list') 返回目录（含已创建的 skill）", async () => {
    createSkill(env.cwd, "explain", "Explain the following code:\n$ARGUMENTS");
    createSkill(env.cwd, "review", "Review `{{path}}` for bugs.");

    const list = await executeTool(
      "Skill",
      { name: "list", description: "List" },
      makeCtx(env.cwd),
    );
    expect(list.ok).toBe(true);
    expect(list.resultText).toContain("explain");
    expect(list.resultText).toContain("review");
  });

  it("Skill('list') 跳过空 SKILL.md 和无 SKILL.md 的目录", async () => {
    createSkill(env.cwd, "real-skill", "Do something");
    // 空内容
    const emptyDir = join(env.cwd, ".claude", "skills", "empty");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "SKILL.md"), "   \n  ", "utf8");
    // 没有 SKILL.md
    mkdirSync(join(env.cwd, ".claude", "skills", "no-file"), { recursive: true });

    const list = await executeTool(
      "Skill",
      { name: "list", description: "List" },
      makeCtx(env.cwd),
    );
    expect(list.ok).toBe(true);
    expect(list.resultText).toContain("real-skill");
    expect(list.resultText).not.toContain("**empty**");
    expect(list.resultText).not.toContain("**no-file**");
  });

  it("Skill('explain') 替换 $ARGUMENTS", async () => {
    createSkill(env.cwd, "explain", "Explain:\n$ARGUMENTS");

    const result = await executeTool(
      "Skill",
      {
        name: "explain",
        description: "Explain",
        params: { arguments: "const x = 1" },
      },
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(true);
    expect(result.resultText).toContain("Explain:");
    expect(result.resultText).toContain("const x = 1");
  });

  it("Skill('explain') $ARGUMENTS 无 .arguments 时退化为 JSON.stringify(params)", async () => {
    createSkill(env.cwd, "explain", "Explain:\n$ARGUMENTS");

    const result = await executeTool(
      "Skill",
      {
        name: "explain",
        description: "Explain",
        params: { code: "x = 1" },
      },
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(true);
    expect(result.resultText).toContain('"code":"x = 1"');
  });

  it("Skill('review') 替换 {{path}}", async () => {
    createSkill(env.cwd, "review", "Review `{{path}}` for bugs.");

    const result = await executeTool(
      "Skill",
      {
        name: "review",
        description: "Review",
        params: { path: "src/main.ts" },
      },
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(true);
    expect(result.resultText).toContain("src/main.ts");
    expect(result.resultText).toContain("Review `src/main.ts` for bugs");
  });

  it("未知 skill 返回 ok=false + 目录", async () => {
    createSkill(env.cwd, "exist", "Existing skill");

    const result = await executeTool(
      "Skill",
      { name: "nonexistent", description: "?" },
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.resultText).toContain("Unknown skill");
    expect(result.resultText).toContain("exist");
  });

  it("缺 name 字段返回 ok=false", async () => {
    const result = await executeTool(
      "Skill",
      { description: "No name" },
      makeCtx(env.cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.resultText).toContain("missing 'name'");
  });

  it("空项目（无 .claude/skills/）返回 'No skills found' 目录", async () => {
    const bareCwd = join(tmpdir(), `invox-skill-bare-${Date.now()}`);
    mkdirSync(bareCwd, { recursive: true });
    try {
      const result = await executeTool(
        "Skill",
        { name: "list", description: "List" },
        makeCtx(bareCwd),
      );
      expect(result.ok).toBe(true);
      expect(result.resultText).toMatch(/No skills found|Available skills/);
    } finally {
      rmSync(bareCwd, { recursive: true, force: true });
    }
  });
});
