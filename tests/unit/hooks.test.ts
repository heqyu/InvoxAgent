// 单测：plugins/hooks.ts —— HookRegistry 加载、缓存与命令执行
//
// PROGRESS A1 硬指标 ——「settings.json / plugins.json hook 加载」覆盖。
// 范围：HookRegistry 加载、缓存语义、disabled plugin、multi-plugin、命令执行。
//
// 策略：
//   1. 在临时目录下构造假 home + 假 cwd，隔离真实 ~/.claude/
//   2. 每个 case 前 clear 所有关联 cache
//   3. 命令执行 spawn 真实的 node -e 进程（轻量，几 ms 完成）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// homedir mock（隔离真实用户设置）
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  HookRegistry,
  loadHooks,
  clearHookCache,
  runUserPromptSubmit,
  runPreToolUse,
  runPostToolUse,
  runPostToolUseFailure,
} from "../../src/plugins/hooks.js";
import { clearDiscoveryCache } from "../../src/discovery/index.js";

// ── helpers ───────────────────────────────────────────────────────────

interface FakeEnv {
  root: string;
  home: string;
  cwd: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "invox-hooks-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  // 写空 settings.json 防止 loadHooks 从 discovery 读不存在的文件
  writeFileSync(join(home, ".claude", "settings.json"), "{}", "utf8");
  writeFileSync(join(cwd, ".claude", "settings.json"), "{}", "utf8");
  return {
    root,
    home,
    cwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 创建插件目录并写入 hooks.json */
function createPlugin(
  env: FakeEnv,
  name: string,
  hooksJson: object,
): string {
  const pluginDir = join(env.cwd, "plugins", name);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify(hooksJson, null, 2),
    "utf8",
  );
  return pluginDir;
}

/** 写 plugins.json 到 project */
function writePluginsJson(env: FakeEnv, entries: object[]): void {
  writeFileSync(
    join(env.cwd, ".claude", "plugins.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

/** node -e 输出 JSON（跨平台） */
function nodeJson(jsObj: string): string {
  return `node -e "process.stdout.write(JSON.stringify(${jsObj})+'\\n')"`;
}

/** node -e 退出 2（阻止语义） */
function nodeBlock(msg: string): string {
  return `node -e "process.stderr.write('${msg}');process.exit(2)"`;
}

// ── 测试 ──────────────────────────────────────────────────────────────

describe("loadHooks", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
    clearDiscoveryCache();
    clearHookCache();
  });

  afterEach(() => {
    clearDiscoveryCache();
    clearHookCache();
    env.cleanup();
  });

  it("空 plugins.json 返回空 registry", () => {
    writePluginsJson(env, []);
    const r = loadHooks(env.cwd);
    expect(r.sessionStart).toHaveLength(0);
    expect(r.userPromptSubmit).toHaveLength(0);
    expect(r.preToolUse).toHaveLength(0);
    expect(r.postToolUse).toHaveLength(0);
    expect(r.postToolUseFailure).toHaveLength(0);
    expect(r.stop).toHaveLength(0);
  });

  it("加载所有 6 种事件", () => {
    const p = createPlugin(env, "test-hooks", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
        PreToolUse: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
        PostToolUse: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
        PostToolUseFailure: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: nodeJson("{continue:true}") }] },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();

    const r = loadHooks(env.cwd);
    expect(r.sessionStart).toHaveLength(1);
    expect(r.userPromptSubmit).toHaveLength(1);
    expect(r.preToolUse).toHaveLength(1);
    expect(r.postToolUse).toHaveLength(1);
    expect(r.postToolUseFailure).toHaveLength(1);
    expect(r.stop).toHaveLength(1);
  });

  it("matcher 和 description 透传", () => {
    const p = createPlugin(env, "test-matcher", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            description: "Pre-hook for write/edit tools",
            hooks: [{ type: "command", command: "echo ok" }],
          },
          {
            matcher: "Bash",
            description: "Blocks Bash",
            hooks: [{ type: "command", command: "exit 2" }],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();

    const r = loadHooks(env.cwd);
    expect(r.preToolUse).toHaveLength(2);
    expect(r.preToolUse[0]!.matcher).toBe("Write|Edit");
    expect(r.preToolUse[0]!.description).toBe("Pre-hook for write/edit tools");
    expect(r.preToolUse[1]!.matcher).toBe("Bash");

    // pluginName 从 plugin.json 读取
    expect(r.preToolUse[0]!.pluginName).toBe("test-matcher");
    expect(r.preToolUse[0]!.pluginRoot).toBe(p);
  });

  it("缓存语义：相同 cwd 两次调用返回同一引用", () => {
    writePluginsJson(env, []);
    const r1 = loadHooks(env.cwd);
    const r2 = loadHooks(env.cwd);
    expect(r1).toBe(r2);
  });

  it("clearHookCache(cwd) 使缓存失效", () => {
    writePluginsJson(env, []);
    const r1 = loadHooks(env.cwd);
    clearHookCache(env.cwd);
    const r2 = loadHooks(env.cwd);
    expect(r1).not.toBe(r2);
  });

  it("clearHookCache() 不传参数清空全部", () => {
    writePluginsJson(env, []);
    const r1 = loadHooks(env.cwd);
    clearHookCache();
    const r2 = loadHooks(env.cwd);
    expect(r1).not.toBe(r2);
  });

  it("disabled plugin 的 hooks 不被加载", () => {
    const p = createPlugin(env, "disabled-hook", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo ok" }] },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: false }]);
    clearHookCache();

    const r = loadHooks(env.cwd);
    expect(r.sessionStart).toHaveLength(0);
  });

  it("多个 plugin 的 hooks 合并加载", () => {
    const p1 = createPlugin(env, "plugin-one", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo p1" }] },
        ],
      },
    });
    const p2 = createPlugin(env, "plugin-two", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo p2" }] },
        ],
      },
    });
    writePluginsJson(env, [
      { path: p1, enabled: true },
      { path: p2, enabled: true },
    ]);
    clearHookCache();

    const r = loadHooks(env.cwd);
    expect(r.sessionStart).toHaveLength(2);
  });
});

describe("hook 命令执行", () => {
  let env: FakeEnv;

  beforeEach(() => {
    env = makeFakeEnv();
    fakeHome = env.home;
    clearDiscoveryCache();
    clearHookCache();
  });

  afterEach(() => {
    clearDiscoveryCache();
    clearHookCache();
    env.cleanup();
  });

  it("runUserPromptSubmit 返回 continue=true 和 systemMessage", async () => {
    const p = createPlugin(env, "test-ups", {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{continue:true,systemMessage:'[hook:test]'}"),
              },
            ],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();
    const registry = loadHooks(env.cwd);

    const result = await runUserPromptSubmit(registry, {
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(result.continue).toBe(true);
    expect(result.systemMessage).toContain("[hook:test]");
  });

  it("runPostToolUse 返回 systemMessage", async () => {
    const p = createPlugin(env, "test-ptu", {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{continue:true,systemMessage:'[post:done]'}"),
              },
            ],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();
    const registry = loadHooks(env.cwd);

    const result = await runPostToolUse(registry, {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
      tool_response: "content",
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(result.systemMessage).toContain("[post:done]");
  });

  it("runPostToolUseFailure 返回 systemMessage", async () => {
    const p = createPlugin(env, "test-ptuf", {
      hooks: {
        PostToolUseFailure: [
          {
            hooks: [
              {
                type: "command",
                command: nodeJson("{continue:true,systemMessage:'[post:failed]'}"),
              },
            ],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();
    const registry = loadHooks(env.cwd);

    const result = await runPostToolUseFailure(registry, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
      tool_input: { file_path: "/bad.txt" },
      tool_response: "error",
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(result.systemMessage).toContain("[post:failed]");
  });

  it("runPreToolUse Bash 被 exit 2 拦截（allow=false）", async () => {
    const p = createPlugin(env, "test-bash-block", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: nodeBlock("dangerous blocked") }],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();
    const registry = loadHooks(env.cwd);

    const result = await runPreToolUse(registry, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason!.toLowerCase()).toContain("block");
  });

  it("runPreToolUse Read 未匹配任何 matcher（allow=true）", async () => {
    const p = createPlugin(env, "test-match", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: nodeJson("{continue:true}") }],
          },
        ],
      },
    });
    writePluginsJson(env, [{ path: p, enabled: true }]);
    clearHookCache();
    const registry = loadHooks(env.cwd);

    const result = await runPreToolUse(registry, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/test.txt" },
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(result.allow).toBe(true);
  });

  it("空 HookRegistry 各路 runner 返回合理默认值", async () => {
    const empty = new HookRegistry();
    const submit = await runUserPromptSubmit(empty, {
      hook_event_name: "UserPromptSubmit",
      prompt: "test",
      session_id: "sess-1",
      cwd: env.cwd,
    });
    expect(submit.continue).toBe(true);
    expect(submit.systemMessage).toBeUndefined();
  });
});
