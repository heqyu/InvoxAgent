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
  readEnvModelLite,
  readEnvModelPro,
  resolveAgentModel,
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
  fakeSpec("MakePlan"),
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

    it("seed 后的 Ask 模板仅开放 Read 且禁用 MCP", () => {
      const r = loadAgentTemplates(env.cwd);
      const ask = r.find((a) => a.id === "Ask");
      expect(ask).toBeDefined();
      expect(ask?.tools).toEqual(["Read"]);
      expect(ask?.mcp).toBe(false);
    });

    it("seed 后的 Plan 模板包含 MakePlan 并要求落盘到 .invox/plans", () => {
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      expect(plan?.tools).toEqual(["Read", "Glob", "Grep", "Skill", "MakePlan"]);
      expect(plan?.prompt).toContain("MakePlan");
      expect(plan?.prompt).toContain(".invox/plans/<theme>.md");
    });

    it("seed 不覆盖用户已有的 Plan.json", () => {
      // 用户先写自定义 Plan
      writeAgent(env.home, "Plan", {
        name: "我的 Plan 不要被覆盖",
        prompt: "user custom plan",

        model: "my-custom-model", // 含 model 字段 → 视作"已升级"，跳过
      });
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      expect(plan?.name).toBe("我的 Plan 不要被覆盖");
      expect(plan?.prompt).toBe("user custom plan");
      expect(plan?.model).toBe("my-custom-model");
    });

    it("旧版 Plan.json（缺 model 字段）会被自动升级补 model=$MODEL_PRO", () => {
      // 模拟 Phase G 时部署的旧 seed：没有 model 字段
      writeAgent(env.home, "Plan", {
        name: "Plan",
        prompt: "old plan prompt without model",
        tools: ["Read", "Glob"],
      });
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      // 升级后用 DEFAULT_USER_AGENTS 的版本（含 model）
      expect(plan?.model).toBe("$MODEL_PRO");
      expect(plan?.tools).toContain("MakePlan");
    });

    it("旧版默认 Plan.json（已有 model 但缺 MakePlan）会升级", () => {
      writeAgent(env.home, "Plan", {
        name: "Plan",
        prompt:
          "You are a planning assistant in Zed. You are in PLAN MODE.\n" +
          "You have NO write access — Edit, Write, and Bash are unavailable.",
        tools: ["Read", "Glob", "Grep", "Skill"],
        model: "$MODEL_PRO",
      });
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      expect(plan?.tools).toEqual(["Read", "Glob", "Grep", "Skill", "MakePlan"]);
      expect(plan?.prompt).toContain("MakePlan");
    });

    it("Ask 旧文件（缺 model）不被升级 —— DEFAULT 中 Ask 本来就没 model", () => {
      writeAgent(env.home, "Ask", {
        name: "我的 Ask",
        prompt: "user custom ask",

      });
      const r = loadAgentTemplates(env.cwd);
      const ask = r.find((a) => a.id === "Ask");
      // 用户自定义保留（DEFAULT.Ask 没 model 字段，所以不触发升级）
      expect(ask?.name).toBe("我的 Ask");
      expect(ask?.prompt).toBe("user custom ask");
    });

    it("旧版默认 Ask.json（prompt 含 NO tools available）会自动升级补 Read 工具", () => {
      writeAgent(env.home, "Ask", {
        name: "Ask",
        prompt:
          "You are a knowledgeable assistant. You are in ASK MODE.\n" +
          "You have NO tools available. You answer based on:\n" +
          "1. The conversation history",
        tools: [],
        mcp: false,
      });
      const r = loadAgentTemplates(env.cwd);
      const ask = r.find((a) => a.id === "Ask");
      expect(ask?.tools).toEqual(["Read"]);
      expect(ask?.prompt).toContain("Read is your ONLY tool");
    });

    it("旧版 Ask.json v2 格式（无 ASK MODE 关键字）也会自动升级", () => {
      writeAgent(env.home, "Ask", {
        name: "Ask",
        prompt:
          "You are a knowledgeable assistant. You have NO tools available.\n" +
          "Answer questions based purely on the conversation context.",
        tools: [],
        mcp: false,
      });
      const r = loadAgentTemplates(env.cwd);
      const ask = r.find((a) => a.id === "Ask");
      expect(ask?.tools).toEqual(["Read"]);
      expect(ask?.prompt).toContain("Read is your ONLY tool");
    });

    it("损坏的 JSON 文件会被修复覆盖", () => {
      const dir = join(env.home, ".invox", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Plan.json"), "{not-json:::", "utf8");
      const r = loadAgentTemplates(env.cwd);
      const plan = r.find((a) => a.id === "Plan");
      // 修复后是 DEFAULT 版本
      expect(plan?.model).toBe("$MODEL_PRO");
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

describe("resolveAgentModel", () => {
  const fb = "fallback-model";

  it("undefined → fallback", () => {
    expect(resolveAgentModel(undefined, fb, {})).toBe(fb);
  });

  it("空字符串 → fallback", () => {
    expect(resolveAgentModel("", fb, {})).toBe(fb);
  });

  it("具体 id（不以 $ 开头）→ 原样返回", () => {
    expect(resolveAgentModel("gpt-4o", fb, {})).toBe("gpt-4o");
    expect(resolveAgentModel("qwen3-coder-30b", fb, {})).toBe(
      "qwen3-coder-30b",
    );
  });

  it("$MODEL_PRO 优先 INVOX_MODEL_PRO", () => {
    expect(
      resolveAgentModel("$MODEL_PRO", fb, {
        INVOX_MODEL_PRO: "claude-3-opus",
        MODEL_PRO: "should-be-ignored",
      }),
    ).toBe("claude-3-opus");
  });

  it("$MODEL_PRO 回退 MODEL_PRO（无前缀别名）", () => {
    expect(
      resolveAgentModel("$MODEL_PRO", fb, { MODEL_PRO: "claude-3-opus" }),
    ).toBe("claude-3-opus");
  });

  it("$MODEL_PRO 两个 env 都未设 → fallback", () => {
    expect(resolveAgentModel("$MODEL_PRO", fb, {})).toBe(fb);
  });

  it("$MODEL_LITE 优先 INVOX_MODEL_LITE", () => {
    expect(
      resolveAgentModel("$MODEL_LITE", fb, {
        INVOX_MODEL_LITE: "gpt-4o-mini",
        MODEL_LITE: "ignored",
      }),
    ).toBe("gpt-4o-mini");
  });

  it("$MODEL_LITE 回退 MODEL_LITE", () => {
    expect(
      resolveAgentModel("$MODEL_LITE", fb, { MODEL_LITE: "haiku" }),
    ).toBe("haiku");
  });

  it("$MODEL_LITE 都未设 → fallback", () => {
    expect(resolveAgentModel("$MODEL_LITE", fb, {})).toBe(fb);
  });

  it("$ANY_VAR 通用 env 引用", () => {
    expect(
      resolveAgentModel("$MY_CUSTOM_MODEL", fb, {
        MY_CUSTOM_MODEL: "deepseek-r1",
      }),
    ).toBe("deepseek-r1");
  });

  it("$ANY_VAR 未设 → fallback", () => {
    expect(resolveAgentModel("$NONEXISTENT", fb, {})).toBe(fb);
  });

  it("$MODEL_PRO 不会因为 INVOX_MODEL_PRO 是空字符串就接受", () => {
    // 空字符串视为未设，回退到 MODEL_PRO 别名再回退到 fallback
    expect(
      resolveAgentModel("$MODEL_PRO", fb, {
        INVOX_MODEL_PRO: "",
        MODEL_PRO: "alias-value",
      }),
    ).toBe("alias-value");
  });
});

describe("readEnvModelPro / readEnvModelLite", () => {
  it("两个 env 都没设 → undefined", () => {
    expect(readEnvModelPro({})).toBeUndefined();
    expect(readEnvModelLite({})).toBeUndefined();
  });

  it("INVOX_ 前缀优先于无前缀别名", () => {
    expect(
      readEnvModelPro({ INVOX_MODEL_PRO: "primary", MODEL_PRO: "alias" }),
    ).toBe("primary");
    expect(
      readEnvModelLite({ INVOX_MODEL_LITE: "primary", MODEL_LITE: "alias" }),
    ).toBe("primary");
  });

  it("仅 alias 时回退使用 alias", () => {
    expect(readEnvModelPro({ MODEL_PRO: "alias-only" })).toBe("alias-only");
    expect(readEnvModelLite({ MODEL_LITE: "alias-only" })).toBe("alias-only");
  });

  it("空字符串视为未设", () => {
    expect(readEnvModelPro({ INVOX_MODEL_PRO: "" })).toBeUndefined();
  });
});

describe("loadAgentTemplates: model 字段", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
  });

  afterEach(() => {
    env.cleanup();
  });

  it("解析文件中的 model 字段", () => {
    writeAgent(env.cwd, "Coder", {
      prompt: "p",
      model: "gpt-4o",
    });
    const r = loadAgentTemplates(env.cwd);
    expect(r.find((a) => a.id === "Coder")?.model).toBe("gpt-4o");
  });

  it("model 字段为空字符串 → 视作未设", () => {
    writeAgent(env.cwd, "NoModel", {
      prompt: "p",
      model: "",
    });
    const r = loadAgentTemplates(env.cwd);
    expect(r.find((a) => a.id === "NoModel")?.model).toBeUndefined();
  });

  it("内置 Worker 默认带 model=$MODEL_LITE", () => {
    const worker = BUILTIN_AGENTS.find((a) => a.id === "Worker");
    expect(worker?.model).toBe("$MODEL_LITE");
  });

  it("seed 出的 Plan 默认带 model=$MODEL_PRO", () => {
    const r = loadAgentTemplates(env.cwd);
    const plan = r.find((a) => a.id === "Plan");
    expect(plan?.model).toBe("$MODEL_PRO");
  });

  it("seed 出的 CodeReviewer 默认带 model=$MODEL_PRO", () => {
    const r = loadAgentTemplates(env.cwd);
    const reviewer = r.find((a) => a.id === "CodeReviewer");
    expect(reviewer?.model).toBe("$MODEL_PRO");
  });

  it("seed 出的 Ask 不设 model（用户决定）", () => {
    const r = loadAgentTemplates(env.cwd);
    const ask = r.find((a) => a.id === "Ask");
    expect(ask?.model).toBeUndefined();
  });
});
