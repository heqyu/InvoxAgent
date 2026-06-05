// 单测：src/agent/sub-agent-runner.ts —— SubAgent 启动器
//
// 范围（不依赖真实 LLM / ACP transport）：
//   - 未知 subagent_type → ok=false，stopReason="refusal"
//   - 空 prompt → ok=false
//   - 已知模板 + 单轮 LLM 回答 → ok=true，finalText 回收 LLM 文本
//   - 父 abort 触发后 subagent 立即停止，stopReason="cancelled"
//   - turnUsage 不累加：父 turnUsage 仅用于父 context 余量估算
//   - 包装的 conn：所有 sessionUpdate 全量静默（不向父 UI 转发）
//   - 独立日志文件：写到 <cwd>/.invox/logs/subagent-*.log，含 start / iter / done

import { describe, expect, it } from "vitest";
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubAgent } from "../../src/agent/sub-agent-runner.js";
import type { IterationDeps } from "../../src/agent/prompt-loop.js";
import type { Session } from "../../src/agent/session-types.js";
import type { AgentTemplate } from "../../src/agent/templates.js";
import { emptyTurnUsage } from "../../src/agent/usage-meter.js";
import type {
  LLMDelta,
  LLMProvider,
  LLMRequest,
  ParsedToolCall,
} from "../../src/llm/types.js";
import { HookRegistry } from "../../src/plugins/hooks.js";
import { FileCache } from "../../src/tools/cache.js";

// ── 测试 fixtures ────────────────────────────────────────────────────

/**
 * 简易 LLM provider：按构造给定的脚本顺序产出 deltas。
 *
 * 每次 stream() 取出脚本下一个数组并 yield。脚本耗尽则只 yield finish。
 * 这样能在多迭代场景里精确控制每轮输出。
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  private cursor = 0;
  constructor(private readonly script: LLMDelta[][]) {}

  async *stream(_req: LLMRequest): AsyncIterable<LLMDelta> {
    const round = this.script[this.cursor];
    this.cursor += 1;
    if (round) {
      for (const d of round) yield d;
      return;
    }
    yield { kind: "finish", reason: "stop" };
  }
}

function textRound(text: string): LLMDelta[] {
  return [
    { kind: "text", text },
    { kind: "finish", reason: "stop" },
  ];
}

function makeParent(cwd?: string): Session {
  return {
    id: "parent-session",
    cwd: cwd ?? "/tmp/sub-agent-test",
    history: [],
    abort: new AbortController(),
    toolState: { readPaths: new Set(), cache: new FileCache() },
    createdAt: 0,
    configValues: { thinking: "off" },
    turnUsage: emptyTurnUsage(),
    turnStartedAt: 0,
    hooks: new HookRegistry(),
  };
}

/** 临时目录 helper —— 给需要"真的写日志文件"的用例用。 */
function makeTmpCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "invox-sub-agent-test-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function makeRecordingConn(): {
  conn: AgentSideConnection;
  notifs: SessionNotification[];
} {
  const notifs: SessionNotification[] = [];
  const conn = {
    sessionUpdate: async (n: SessionNotification) => {
      notifs.push(n);
    },
  } as unknown as AgentSideConnection;
  return { conn, notifs };
}

function makeDeps(
  conn: AgentSideConnection,
  provider: LLMProvider,
  registry: ReadonlyMap<string, AgentTemplate>,
): IterationDeps {
  return {
    conn,
    provider,
    clientCaps: {},
    policy: "never",
    defaultModelId: "test-model",
    buildHookBase: () => ({
      session_id: "parent-session",
      cwd: "/tmp/sub-agent-test",
      model: "test-model",
      client: "test",
      version: "test",
    }),
    agentRegistry: registry,
  };
}

const WORKER_TPL: AgentTemplate = {
  id: "Worker",
  name: "Worker",
  prompt: "you are a worker",
  // 显式空数组：subagent 无内置工具可用 —— 确保单轮直接回答即可结束，
  // 不会被 LLM 逼着调工具
  tools: [],
  mcp: false,
};

// ── 用例 ──────────────────────────────────────────────────────────────

describe("runSubAgent", () => {
  it("拒绝未知 subagent_type，返回 refusal + 错误说明", async () => {
    const parent = makeParent();
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "DoesNotExist", prompt: "hi" },
      new AbortController().signal,
    );

    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("refusal");
    expect(r.iterations).toBe(0);
    expect(r.error).toMatch(/unknown subagent_type/);
    expect(r.error).toContain("Worker");
  });

  it("拒绝空 prompt", async () => {
    const parent = makeParent();
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "   " },
      new AbortController().signal,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing 'prompt'/);
  });

  it("注册表为空时直接拒绝", async () => {
    const parent = makeParent();
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([]);
    const deps = makeDeps(conn, provider, new Map());

    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "hi" },
      new AbortController().signal,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no agent templates loaded/);
  });

  it("跑通已知模板：LLM 单轮文本输出 → ok=true + finalText 回收", async () => {
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);
      const { conn, notifs } = makeRecordingConn();
      const provider = new ScriptedProvider([textRound("hello from sub")]);
      const registry = new Map([["Worker", WORKER_TPL]]);
      const deps = makeDeps(conn, provider, registry);

      const r = await runSubAgent(
        { parentDeps: deps, parent },
        { subagentType: "Worker", prompt: "say hi", description: "greet" },
        new AbortController().signal,
      );

      expect(r.ok).toBe(true);
      expect(r.stopReason).toBe("end_turn");
      expect(r.iterations).toBe(1);
      expect(r.finalText).toBe("hello from sub");

      // 包装 conn 全量静默：所有 sessionUpdate 都不向父 UI 转发
      expect(notifs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("subagent 的 token 消耗不累加进父 turnUsage（父 turnUsage 仅用于父 context 余量估算）", async () => {
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);
      // 模拟父已有过一些消耗
      parent.turnUsage.input = 500;
      parent.turnUsage.output = 80;
      parent.turnUsage.total = 580;
      parent.turnUsage.calls = 1;
      parent.turnUsage.maxPrompt = 500;

      const { conn, notifs } = makeRecordingConn();
      const provider = new ScriptedProvider([
        [
          { kind: "text", text: "ok" },
          // subagent 内部产生了 token —— 但不应影响 parent.turnUsage
          {
            kind: "usage",
            usage: { input: 100, output: 20, total: 120, cached: 0 },
          },
          { kind: "finish", reason: "stop" },
        ],
      ]);
      const registry = new Map([["Worker", WORKER_TPL]]);
      const deps = makeDeps(conn, provider, registry);

      const r = await runSubAgent(
        { parentDeps: deps, parent },
        { subagentType: "Worker", prompt: "x" },
        new AbortController().signal,
      );
      expect(r.ok).toBe(true);

      // 父 turnUsage 完全不变 —— subagent 跑在独立 history，不占父 context
      expect(parent.turnUsage.input).toBe(500);
      expect(parent.turnUsage.output).toBe(80);
      expect(parent.turnUsage.total).toBe(580);
      expect(parent.turnUsage.calls).toBe(1);
      expect(parent.turnUsage.maxPrompt).toBe(500);

      // 包装 conn 全量静默 —— 不应转发任何 sessionUpdate
      expect(notifs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("父 abort 触发后 subagent 立即收尾为 cancelled", async () => {
    const parent = makeParent();
    parent.abort.abort(); // 模拟父 turn 已被取消
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([textRound("would say hi")]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "x" },
      new AbortController().signal,
    );
    expect(r.stopReason).toBe("cancelled");
    expect(r.ok).toBe(false);
  });

  it("外部 signal abort 也能取消 subagent", async () => {
    const parent = makeParent();
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([textRound("hi")]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "x" },
      ctrl.signal,
    );
    expect(r.stopReason).toBe("cancelled");
  });

  it("解析 model：modelOverride > template.model > parent.selectedModel", async () => {
    const parent = makeParent();
    parent.selectedModel = "parent-default";
    const { conn } = makeRecordingConn();

    // 通过 capture 第一个 LLM 请求里的 model 字段断言
    const seenModels: string[] = [];
    class CaptureProvider implements LLMProvider {
      readonly name = "capture";
      async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
        seenModels.push(req.model ?? "<unset>");
        yield* textRound("done");
      }
    }
    const provider = new CaptureProvider();

    const tpl: AgentTemplate = {
      id: "Plan",
      name: "Plan",
      prompt: "plan prompt",
      tools: [],
      model: "tpl-model",
    };
    const registry = new Map([["Plan", tpl]]);
    const deps = makeDeps(conn, provider, registry);

    // 1. modelOverride 优先
    await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Plan", prompt: "x", modelOverride: "explicit-override" },
      new AbortController().signal,
    );
    // 2. 无 override → template.model
    await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Plan", prompt: "x" },
      new AbortController().signal,
    );

    expect(seenModels[0]).toBe("explicit-override");
    expect(seenModels[1]).toBe("tpl-model");
  });

  it("subagent 的 history 不污染父 history", async () => {
    const parent = makeParent();
    parent.history = [{ role: "user", content: "parent original" }];
    const { conn } = makeRecordingConn();
    const provider = new ScriptedProvider([textRound("sub answer")]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "go" },
      new AbortController().signal,
    );

    // 父 history 维度未变 —— subagent 的 history 是独立的
    expect(parent.history).toEqual([{ role: "user", content: "parent original" }]);
  });

  it("LLM 试图调用工具时 subagent 仍能完成（即便 toolSpec 不暴露 SubAgent）", async () => {
    // 即便 LLM 因记忆硬调 SubAgent，运行时也不会有 Tool 路由（subagent
    // 的 tools=[] 把内置工具全过滤了；inSubAgent=true 又额外移除 SubAgent）。
    // 这条用例让 subagent 直接给 finish=stop，验证 happy path 的最小集合。
    const parent = makeParent();
    const { conn } = makeRecordingConn();
    // tool_calls 为空且 finish reason=stop → subagent 一轮即结束
    const provider = new ScriptedProvider([
      [
        { kind: "text", text: "no tools needed" },
        { kind: "finish", reason: "stop" },
      ],
    ]);
    const registry = new Map([["Worker", WORKER_TPL]]);
    const deps = makeDeps(conn, provider, registry);

    const r = await runSubAgent(
      { parentDeps: deps, parent },
      { subagentType: "Worker", prompt: "x" },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    expect(r.finalText).toBe("no tools needed");
  });

  it("写独立日志文件到 <cwd>/.invox/logs/，含 start / iter / done 三段", async () => {
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);
      const { conn } = makeRecordingConn();
      const provider = new ScriptedProvider([textRound("logged answer")]);
      const registry = new Map([["Worker", WORKER_TPL]]);
      const deps = makeDeps(conn, provider, registry);

      const r = await runSubAgent(
        { parentDeps: deps, parent },
        {
          subagentType: "Worker",
          prompt: "task A",
          description: "do task A",
        },
        new AbortController().signal,
      );

      expect(r.ok).toBe(true);
      expect(r.logPath).toBeTruthy();
      expect(existsSync(r.logPath!)).toBe(true);
      // 文件位于 <cwd>/.invox/logs/，文件名以 subagent- 开头
      expect(r.logPath!.includes(join(".invox", "logs"))).toBe(true);
      expect(r.logPath!.includes("subagent-")).toBe(true);

      const content = readFileSync(r.logPath!, "utf8");
      // start 段
      expect(content).toContain("subagent start");
      expect(content).toContain("subagent_type: Worker");
      expect(content).toContain("description:   do task A");
      expect(content).toContain("model:");
      expect(content).toContain("prompt:");
      // iter 段
      expect(content).toMatch(/iter 1: start/);
      expect(content).toMatch(/iter 1: stop end_turn/);
      // done 段
      expect(content).toContain("subagent done");
      expect(content).toContain("stopReason:    end_turn");
      expect(content).toContain("iterations:    1");
      expect(content).toContain("finalText:");
      expect(content).toContain("logged answer");

      // 目录里只应有 1 个日志文件
      const files = readdirSync(join(cwd, ".invox", "logs"));
      expect(files.filter((f) => f.startsWith("subagent-"))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("两个 subagent 并发运行，各自有独立日志文件 + 互不污染", async () => {
    // 同时跑两个 subagent，验证：
    //   1. Promise.all 等都完成 → 都返回 ok=true
    //   2. 两个独立日志文件都被生成
    //   3. 两份 history 互不污染：分别拿到自己的 finalText
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);

      // 两路 provider：每个自己脚本一路，确保两次 stream 调用互不干扰
      // —— 这里复用 ScriptedProvider，但每个 subagent 各拿一个新实例
      const { conn } = makeRecordingConn();

      const registry = new Map([["Worker", WORKER_TPL]]);
      const deps1 = makeDeps(
        conn,
        new ScriptedProvider([textRound("sub-A done")]),
        registry,
      );
      const deps2 = makeDeps(
        conn,
        new ScriptedProvider([textRound("sub-B done")]),
        registry,
      );

      const [rA, rB] = await Promise.all([
        runSubAgent(
          { parentDeps: deps1, parent },
          { subagentType: "Worker", prompt: "task A" },
          new AbortController().signal,
        ),
        runSubAgent(
          { parentDeps: deps2, parent },
          { subagentType: "Worker", prompt: "task B" },
          new AbortController().signal,
        ),
      ]);

      expect(rA.ok).toBe(true);
      expect(rB.ok).toBe(true);
      expect(rA.finalText).toBe("sub-A done");
      expect(rB.finalText).toBe("sub-B done");

      // 两个独立日志文件
      expect(rA.logPath).not.toBe(rB.logPath);
      expect(existsSync(rA.logPath!)).toBe(true);
      expect(existsSync(rB.logPath!)).toBe(true);

      // 父 history 完全没被改动
      expect(parent.history).toEqual([]);
      // 父 turnUsage 完全没被累加
      expect(parent.turnUsage.calls).toBe(0);

      // 目录里有 2 个 subagent 文件
      const files = readdirSync(join(cwd, ".invox", "logs")).filter((f) =>
        f.startsWith("subagent-"),
      );
      expect(files).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("传入 parentToolCallId 时，inner tool_call 触发父工具卡的 tool_call_update（实时进度）", async () => {
    // 模拟 LLM 第一轮发出一个内部 tool_call（Read），第二轮直接回答收尾。
    // 期望：runner 通过父 conn 发出至少 2 帧 tool_call_update（"started" 帧 +
    // "▸ Read xxx" 帧），且这些 update 的 toolCallId === parentToolCallId。
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);
      const { conn, notifs } = makeRecordingConn();

      // 给 subagent 开一个 Read 工具的白名单 —— 让 prompt-loop 能真的执行
      // 这个 inner tool_call 并 emit `tool_call` 通知（tool 执行也读文件，
      // 我们在 cwd 下放一个文件让 Read 成功）
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(cwd, "hello.txt"), "hi", "utf8");

      const tplWithRead: AgentTemplate = {
        id: "ReaderAgent",
        name: "ReaderAgent",
        prompt: "you can read files",
        tools: ["Read"],
        mcp: false,
      };

      // Round 1：发起 Read tool_call；Round 2：finish=stop（结束）
      const provider = new ScriptedProvider([
        [
          {
            kind: "tool_call",
            call: {
              id: "inner-call-1",
              name: "Read",
              arguments: JSON.stringify({ path: join(cwd, "hello.txt") }),
            },
          },
          { kind: "finish", reason: "tool_calls" },
        ],
        [
          { kind: "text", text: "done reading" },
          { kind: "finish", reason: "stop" },
        ],
      ]);

      const registry = new Map([["ReaderAgent", tplWithRead]]);
      const deps = makeDeps(conn, provider, registry);

      const r = await runSubAgent(
        { parentDeps: deps, parent },
        {
          subagentType: "ReaderAgent",
          prompt: "read the file",
          parentToolCallId: "parent-tc-42",
        },
        new AbortController().signal,
      );

      expect(r.ok).toBe(true);

      // 父 conn 收到的所有 update 应 *只* 是 tool_call_update（subagent
      // 内部的 tool_call 等被 wrappedConn 静默；只有 progress emitter 会
      // 发 tool_call_update 到父 conn）
      const seen = notifs.map((n) => ({
        kind: n.update.sessionUpdate,
        toolCallId: (n.update as { toolCallId?: string }).toolCallId,
      }));
      const progressNotifs = seen.filter(
        (e) =>
          e.kind === "tool_call_update" && e.toolCallId === "parent-tc-42",
      );
      // 至少 2 帧：startup 帧（"subagent started"）+ Read 帧
      expect(progressNotifs.length).toBeGreaterThanOrEqual(2);

      // 不应有任何 sessionUpdate 用别的 toolCallId（即没漏出 inner 子卡）
      const otherToolCallIds = seen.filter(
        (e) =>
          e.toolCallId !== undefined && e.toolCallId !== "parent-tc-42",
      );
      expect(otherToolCallIds).toHaveLength(0);

      // 进度 lines 应包含 Log 行 + started + Read 行
      expect(r.progressLines).toBeDefined();
      const lines = r.progressLines!;
      expect(lines[0]).toMatch(/^Log: /);
      expect(lines.some((l) => l === "▸ subagent started")).toBe(true);
      expect(lines.some((l) => l.startsWith("▸ Read"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("不传 parentToolCallId 时，runner 不发任何 tool_call_update（保持纯静默）", async () => {
    const { cwd, cleanup } = makeTmpCwd();
    try {
      const parent = makeParent(cwd);
      const { conn, notifs } = makeRecordingConn();
      const provider = new ScriptedProvider([textRound("hi")]);
      const registry = new Map([["Worker", WORKER_TPL]]);
      const deps = makeDeps(conn, provider, registry);

      const r = await runSubAgent(
        { parentDeps: deps, parent },
        { subagentType: "Worker", prompt: "x" },
        new AbortController().signal,
      );
      expect(r.ok).toBe(true);
      expect(r.progressLines).toBeUndefined();
      expect(notifs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("SubAgent 工具暴露", () => {
  it("作为内置工具出现在 TOOL_SPECS 中", async () => {
    const { TOOL_SPECS } = await import("../../src/tools/registry.js");
    const names = TOOL_SPECS.map((s) => s.function.name);
    expect(names).toContain("SubAgent");
  });

  it("required 字段满足 description / prompt / subagent_type", async () => {
    const { TOOL_SPECS } = await import("../../src/tools/registry.js");
    const spec = TOOL_SPECS.find((s) => s.function.name === "SubAgent");
    expect(spec).toBeDefined();
    expect(spec!.function.parameters.required).toEqual([
      "description",
      "prompt",
      "subagent_type",
    ]);
  });

  it("ctx 中无 subAgentRunner 时返回结构化错误（递归屏障）", async () => {
    const { subAgentTool } = await import("../../src/tools/sub-agent.js");
    const r = await subAgentTool.execute(
      {
        description: "x",
        prompt: "y",
        subagent_type: "Worker",
      },
      {
        // 模拟 subagent 内部调用：subAgentRunner 不注入
        conn: {} as AgentSideConnection,
        sessionId: "s",
        cwd: "/tmp",
        caps: {},
        signal: new AbortController().signal,
        policy: "never",
        toolCallId: "tc-1",
        state: { readPaths: new Set(), cache: new FileCache() },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.resultText).toMatch(/recursive subagent calls are forbidden/);
  });

  it("缺 subagent_type 时返回结构化错误", async () => {
    const { subAgentTool } = await import("../../src/tools/sub-agent.js");
    const r = await subAgentTool.execute(
      { description: "x", prompt: "y" },
      {
        conn: {} as AgentSideConnection,
        sessionId: "s",
        cwd: "/tmp",
        caps: {},
        signal: new AbortController().signal,
        policy: "never",
        toolCallId: "tc-1",
        state: { readPaths: new Set(), cache: new FileCache() },
        subAgentRunner: async () => ({
          ok: true,
          finalText: "",
          stopReason: "end_turn",
          iterations: 0,
        }),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.resultText).toMatch(/missing 'subagent_type'/);
  });

  it("成功路径：runner 返回 finalText → 工具结果带 provenance header", async () => {
    const { subAgentTool } = await import("../../src/tools/sub-agent.js");
    const r = await subAgentTool.execute(
      {
        description: "investigate auth",
        prompt: "find auth code",
        subagent_type: "Plan",
      },
      {
        conn: {} as AgentSideConnection,
        sessionId: "s",
        cwd: "/tmp",
        caps: {},
        signal: new AbortController().signal,
        policy: "never",
        toolCallId: "tc-1",
        state: { readPaths: new Set(), cache: new FileCache() },
        subAgentRunner: async () => ({
          ok: true,
          finalText: "saved plan to .invox/plans/auth.md",
          stopReason: "end_turn",
          iterations: 4,
        }),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.title).toBe("investigate auth (Plan)");
    expect(r.resultText).toContain("[subagent: Plan]");
    expect(r.resultText).toContain("4 iter, end_turn");
    expect(r.resultText).toContain("saved plan to .invox/plans/auth.md");
  });
});
