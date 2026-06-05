// 单测：src/agent/templates.ts —— 自定义 Agent 模板的 loader 与工具过滤
//
// 范围：
//   - loadAgentTemplates：项目级 / 用户级 / 内置兜底 三层合并；坏文件容错
//   - filterToolSpecsByAgent：白名单 / 黑名单 / 混合 / 显式空数组 四态语义
//   - agentAllowsMcp：默认 true、显式 false 的边界

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "../../src/llm/types.js";

// homedir() mock —— 必须在 import templates.ts 之前 hoist
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  BUILTIN_AGENTS,
  agentAllowsMcp,
  filterToolSpecsByAgent,
  loadAgentTemplates,
  type AgentTemplate,
} from "../../src/agent/templates.js";

// ── 临时目录 helper ──────────────────────────────────────────────────

interface FakeEnv {
  home: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "invox-agents-test-"));
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

function writeAgent(
  rootDir: string,
  id: string,
  body: Record<string, unknown>,
): void {
  const dir = join(rootDir, ".invox", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body, null, 2), "utf8");
}

// ── ToolSpec 假数据 ──────────────────────────────────────────────────

const fakeSpec = (name: string): ToolSpec => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  },
});

const ALL_SPECS: ToolSpec[] = [
  fakeSpec("Read"),
  fakeSpec("Write"),
  fakeSpec("Edit"),
  fakeSpec("Glob"),
  fakeSpec("Grep"),
  fakeSpec("Bash"),
  fakeSpec("Skill"),
];

// ── 测试 ──────────────────────────────────────────────────────────────

describe("loadAgentTemplates", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("内置 + 用户级 seed", () => {
    it("两个目录都没文件时：自动 seed 用户级 + 内置 Worker = 4 条", () => {
      // loadAgentTemplates 首次调用会 seed ~/.invox/agents/{Plan,Ask,CodeReviewer}.json
      // 我们把 fakeHome 指向 tmp 目录，所以 seed 写到隔离环境里
      const r = loadAgentTemplates(env.cwd);
      expect(r.length).toBe(4);
      expect(r.map((a) => a.id).sort()).toEqual(
        ["Ask", "CodeReviewer", "Plan", "Worker"].sort(),
      );
    });

    it("BUILTIN_AGENTS 内的所有条目 id / prompt / name 满足合法规范", () => {
      for (const a of BUILTIN_AGENTS) {
        expect(a.id).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(a.prompt.length).toBeGreaterThan(0);
        expect(a.name.length).toBeGreaterThan(0);
      }
    });

    it("seed 后的 Ask 模板禁用全部工具且禁用 MCP", () => {
      const r = loadAgentTemplates(env.cwd);
      const ask = r.find((a) => a.id === "Ask");
      expect(ask).toBeDefined();
      expect(ask?.tools).toEqual([]);
      expect(ask?.mcp).toBe(false);
    });

    it("seed 不覆盖用户已有的 Plan.json", () => {
      // 用户先写自定义 Plan
      writeAgent(env.home, "Plan", {
        name: "我的 Plan 不要被覆盖",
        prompt: "user custom plan",
      });
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      expect(plan?.name).toBe("我的 Plan 不要被覆盖");
      expect(plan?.prompt).toBe("user custom plan");
    });
  });

  describe("项目级文件加载", () => {
    it("加载有效 JSON 并解析所有字段", () => {
      writeAgent(env.cwd, "Custom", {
        name: "我的自定义",
        description: "测试",
        prompt: "You are custom.",
        tools: ["Read", "Glob"],
        mcp: false,
      });
      const r = loadAgentTemplates(env.cwd);
      const custom = r.find((a) => a.id === "Custom");
      expect(custom).toBeDefined();
      expect(custom?.name).toBe("我的自定义");
      expect(custom?.description).toBe("测试");
      expect(custom?.prompt).toBe("You are custom.");
      expect(custom?.tools).toEqual(["Read", "Glob"]);
      expect(custom?.mcp).toBe(false);
    });

    it("文件名作为 id（忽略文件内 id 字段）", () => {
      writeAgent(env.cwd, "FileNameWins", {
        id: "ShouldBeIgnored", // 文件内的 id 应被忽略
        prompt: "x",
      });
      const r = loadAgentTemplates(env.cwd);
      expect(r.some((a) => a.id === "FileNameWins")).toBe(true);
      expect(r.some((a) => a.id === "ShouldBeIgnored")).toBe(false);
    });

    it("name 缺失时 fallback 用 id", () => {
      writeAgent(env.cwd, "NoName", { prompt: "p" });
      const r = loadAgentTemplates(env.cwd);
      expect(r.find((a) => a.id === "NoName")?.name).toBe("NoName");
    });

    it("缺 prompt 字段的文件被跳过", () => {
      writeAgent(env.cwd, "Bad", { name: "no prompt" });
      const r = loadAgentTemplates(env.cwd);
      expect(r.some((a) => a.id === "Bad")).toBe(false);
    });

    it("非法 JSON 的文件被跳过，其它继续", () => {
      const dir = join(env.cwd, ".invox", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "BadJson.json"), "{not-json:::", "utf8");
      writeAgent(env.cwd, "Good", { prompt: "good" });
      const r = loadAgentTemplates(env.cwd);
      expect(r.some((a) => a.id === "Good")).toBe(true);
      expect(r.some((a) => a.id === "BadJson")).toBe(false);
    });

    it("非 .json 后缀文件被忽略", () => {
      const dir = join(env.cwd, ".invox", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "README.md"),
        "Not an agent",
        "utf8",
      );
      writeAgent(env.cwd, "OK", { prompt: "ok" });
      const r = loadAgentTemplates(env.cwd);
      expect(r.some((a) => a.id === "README")).toBe(false);
      expect(r.some((a) => a.id === "OK")).toBe(true);
    });

    it("非法 id（含特殊字符）的文件被跳过", () => {
      const dir = join(env.cwd, ".invox", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "bad name.json"),
        JSON.stringify({ prompt: "x" }),
        "utf8",
      );
      const r = loadAgentTemplates(env.cwd);
      expect(r.some((a) => a.id === "bad name")).toBe(false);
    });
  });

  describe("项目 + 用户 + 内置 三层合并", () => {
    it("项目级覆盖用户级（同 id 仅保留项目级）", () => {
      writeAgent(env.home, "Plan", {
        name: "User Plan",
        prompt: "user version",
      });
      writeAgent(env.cwd, "Plan", {
        name: "Project Plan",
        prompt: "project version",
      });
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      expect(plan?.name).toBe("Project Plan");
      expect(plan?.prompt).toBe("project version");
    });

    it("用户级覆盖内置（同 id 仅保留用户级）", () => {
      writeAgent(env.home, "Worker", {
        name: "My Custom Worker",
        prompt: "user worker override",
      });
      const r = loadAgentTemplates(env.cwd);
      const worker = r.find((a) => a.id === "Worker");
      expect(worker?.name).toBe("My Custom Worker");
      expect(worker?.prompt).toBe("user worker override");
    });

    it("项目级新增条目排在最前", () => {
      writeAgent(env.cwd, "MyProject", { prompt: "p" });
      const r = loadAgentTemplates(env.cwd);
      expect(r[0]?.id).toBe("MyProject");
    });

    it("结果至少包含全部内置（未被覆盖的部分）", () => {
      writeAgent(env.cwd, "Worker", { prompt: "override" });
      const r = loadAgentTemplates(env.cwd);
      const ids = new Set(r.map((a) => a.id));
      // Worker 被项目级覆盖（仍在），其它三套内置不变
      expect(ids.has("Worker")).toBe(true);
      expect(ids.has("Plan")).toBe(true);
      expect(ids.has("Ask")).toBe(true);
      expect(ids.has("CodeReviewer")).toBe(true);
    });
  });
});

describe("filterToolSpecsByAgent", () => {
  it("undefined → 返回全部", () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, undefined);
    expect(r.length).toBe(ALL_SPECS.length);
  });

  it('["*"] → 返回全部', () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["*"]);
    expect(r.length).toBe(ALL_SPECS.length);
  });

  it("[] → 返回空", () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, []);
    expect(r).toEqual([]);
  });

  it('严格白名单 ["Read","Glob"]', () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["Read", "Glob"]);
    expect(r.map((s) => s.function.name).sort()).toEqual(["Glob", "Read"]);
  });

  it('全集减法 ["-Bash","-Write"]（无显式 "*"）', () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["-Bash", "-Write"]);
    const names = r.map((s) => s.function.name);
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("Write");
    expect(names).toContain("Read");
    expect(names).toContain("Edit");
    expect(r.length).toBe(ALL_SPECS.length - 2);
  });

  it('全集减法 ["*","-Bash"]', () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["*", "-Bash"]);
    expect(r.map((s) => s.function.name)).not.toContain("Bash");
    expect(r.length).toBe(ALL_SPECS.length - 1);
  });

  it("正项 + 负项混合 → 按全集减法处理（warn）", () => {
    // 含 "-Edit" 触发减法模式；正项 ["Read"] 被忽略
    const r = filterToolSpecsByAgent(ALL_SPECS, ["Read", "-Edit"]);
    const names = r.map((s) => s.function.name);
    expect(names).not.toContain("Edit");
    // 不会只剩 Read —— 是减法不是白名单
    expect(names.length).toBe(ALL_SPECS.length - 1);
    expect(names).toContain("Bash");
  });

  it("白名单含未知工具 → 仅 warn 跳过，已知项仍生效", () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["Read", "Nonexistent"]);
    expect(r.map((s) => s.function.name)).toEqual(["Read"]);
  });

  it("减法含未知工具 → 全集减去存在的项，未知项被忽略", () => {
    const r = filterToolSpecsByAgent(ALL_SPECS, ["-Bash", "-Imaginary"]);
    expect(r.map((s) => s.function.name)).not.toContain("Bash");
    expect(r.length).toBe(ALL_SPECS.length - 1);
  });

  it("不修改原 specs 数组", () => {
    const before = ALL_SPECS.length;
    filterToolSpecsByAgent(ALL_SPECS, ["Read"]);
    expect(ALL_SPECS.length).toBe(before);
  });
});

describe("agentAllowsMcp", () => {
  it("undefined agent → true", () => {
    expect(agentAllowsMcp(undefined)).toBe(true);
  });

  it("agent.mcp 未设 → true", () => {
    const a: AgentTemplate = { id: "x", name: "x", prompt: "p" };
    expect(agentAllowsMcp(a)).toBe(true);
  });

  it("agent.mcp = true → true", () => {
    const a: AgentTemplate = { id: "x", name: "x", prompt: "p", mcp: true };
    expect(agentAllowsMcp(a)).toBe(true);
  });

  it("agent.mcp = false → false", () => {
    const a: AgentTemplate = { id: "x", name: "x", prompt: "p", mcp: false };
    expect(agentAllowsMcp(a)).toBe(false);
  });
});
