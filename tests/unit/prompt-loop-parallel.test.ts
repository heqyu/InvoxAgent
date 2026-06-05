// 单测：prompt-loop 的工具调用并行批次规划与执行。

import { describe, expect, it } from "vitest";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  isParallelSafeToolCall,
  planToolCallBatches,
  runOneIteration,
  type IterationDeps,
} from "../../src/agent/prompt-loop.js";
import type { Session } from "../../src/agent/session-types.js";
import { emptyTurnUsage } from "../../src/agent/usage-meter.js";
import type {
  LLMDelta,
  LLMProvider,
  LLMRequest,
  ParsedToolCall,
} from "../../src/llm/types.js";
import { HookRegistry } from "../../src/plugins/hooks.js";
import { FileCache } from "../../src/tools/cache.js";

function makeCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ParsedToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TwoReadProvider implements LLMProvider {
  readonly name = "two-read";

  async *stream(_req: LLMRequest): AsyncIterable<LLMDelta> {
    yield makeDelta(makeCall("read_a", "Read", { path: "a.txt" }));
    yield makeDelta(makeCall("read_b", "Read", { path: "b.txt" }));
    yield { kind: "finish", reason: "tool_calls" };
  }
}

function makeDelta(call: ParsedToolCall): LLMDelta {
  return { kind: "tool_call", call };
}

function makeSession(cwd: string): Session {
  return {
    id: "session-1",
    cwd,
    history: [{ role: "user", content: "read both files" }],
    abort: new AbortController(),
    toolState: { readPaths: new Set(), cache: new FileCache() },
    createdAt: Date.now(),
    configValues: {},
    turnUsage: emptyTurnUsage(),
    turnStartedAt: Date.now(),
    hooks: new HookRegistry(),
  };
}

describe("prompt-loop 并行工具调用", () => {
  it("只读工具合并为并行批次，Edit/Bash/写入/MCP 作为顺序屏障", () => {
    const calls = [
      makeCall("1", "Read", { path: "a.ts" }),
      makeCall("2", "Grep", { pattern: "foo" }),
      makeCall("3", "Bash", { command: "npm test" }),
      makeCall("4", "Glob", { pattern: "**/*.ts" }),
      makeCall("5", "Edit", {
        path: "a.ts",
        old_string: "foo",
        new_string: "bar",
      }),
      makeCall("6", "Read", { path: "b.ts" }),
      makeCall("7", "Write", { path: "c.ts", content: "x" }),
      makeCall("8", "Skill", { name: "demo" }),
      makeCall("9", "mcp__srv__tool", {}),
    ];

    expect(isParallelSafeToolCall(calls[0]!)).toBe(true);
    expect(isParallelSafeToolCall(calls[2]!)).toBe(false);
    expect(isParallelSafeToolCall(calls[4]!)).toBe(false);
    expect(isParallelSafeToolCall(calls[6]!)).toBe(false);
    expect(isParallelSafeToolCall(calls[8]!)).toBe(false);

    expect(
      planToolCallBatches(calls).map((batch) => ({
        mode: batch.mode,
        names: batch.calls.map((call) => call.name),
      })),
    ).toEqual([
      { mode: "parallel", names: ["Read", "Grep"] },
      { mode: "serial", names: ["Bash"] },
      { mode: "parallel", names: ["Glob"] },
      { mode: "serial", names: ["Edit"] },
      { mode: "parallel", names: ["Read"] },
      { mode: "serial", names: ["Write"] },
      { mode: "parallel", names: ["Skill"] },
      { mode: "serial", names: ["mcp__srv__tool"] },
    ]);
  });

  it("SubAgent 即便是 execute tier 也作为并行安全 —— 多 subagent 同 turn 并发启动", () => {
    // 设计意图：subagent 之间无共享可变状态（各自独立 history/toolState/abort），
    // LLM 一次性派发 N 个 subagent 时让父 prompt-loop 把它们打成同一个 parallel
    // batch，总耗时降为 max 而非 sum。
    const calls = [
      makeCall("1", "SubAgent", {
        description: "x",
        prompt: "p1",
        subagent_type: "Plan",
      }),
      makeCall("2", "SubAgent", {
        description: "x",
        prompt: "p2",
        subagent_type: "Ask",
      }),
      makeCall("3", "Read", { path: "x.ts" }),
      makeCall("4", "Edit", {
        path: "x.ts",
        old_string: "a",
        new_string: "b",
      }),
      makeCall("5", "SubAgent", {
        description: "x",
        prompt: "p3",
        subagent_type: "CodeReviewer",
      }),
    ];

    expect(isParallelSafeToolCall(calls[0]!)).toBe(true);
    expect(isParallelSafeToolCall(calls[1]!)).toBe(true);
    expect(isParallelSafeToolCall(calls[3]!)).toBe(false);
    expect(isParallelSafeToolCall(calls[4]!)).toBe(true);

    // 期望：[SubAgent×2, Read] 并行，Edit 屏障，[SubAgent] 并行
    expect(
      planToolCallBatches(calls).map((batch) => ({
        mode: batch.mode,
        names: batch.calls.map((call) => call.name),
      })),
    ).toEqual([
      { mode: "parallel", names: ["SubAgent", "SubAgent", "Read"] },
      { mode: "serial", names: ["Edit"] },
      { mode: "parallel", names: ["SubAgent"] },
    ]);
  });

  it("同一并行批次的 Read 会同时发起，并按原始 tool_call 顺序写入 history", async () => {
    const root = mkdtempSync(join(tmpdir(), "invox-parallel-test-"));
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });

    let activeReads = 0;
    let maxActiveReads = 0;

    const conn = {
      sessionUpdate: async () => {},
      readTextFile: async ({ path }: { path: string }) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await sleep(30);
        activeReads -= 1;
        return { content: `content from ${basename(path)}` };
      },
    } as unknown as AgentSideConnection;

    try {
      const session = makeSession(cwd);
      const deps: IterationDeps = {
        conn,
        provider: new TwoReadProvider(),
        clientCaps: { fs: { readTextFile: true } } as ClientCapabilities,
        policy: "never",
        defaultModelId: "test-model",
        buildHookBase: () => ({
          session_id: session.id,
          cwd: session.cwd,
          model: "test-model",
          client: "test",
          version: "test",
        }),
      };

      const result = await runOneIteration(session, deps);
      const toolMessages = session.history.filter((msg) => msg.role === "tool");

      expect(result).toEqual({ kind: "continue" });
      expect(maxActiveReads).toBe(2);
      expect(toolMessages.map((msg) => msg.tool_call_id)).toEqual([
        "read_a",
        "read_b",
      ]);
      expect(toolMessages.map((msg) => msg.name)).toEqual(["Read", "Read"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
