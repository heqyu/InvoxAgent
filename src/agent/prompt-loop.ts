// 单轮 LLM ↔ tool 往返的核心循环。
//
// 设计契约：
//   - 入参 deps 是 InvoxAgent 内部状态的只读视图（provider、conn、policy、
//     clientCaps、defaultModelId、hookBase 构造器）。本函数不持有 InvoxAgent
//     实例引用，便于单测注入 mock
//   - 返回 discriminated union：
//       { kind: "stop", reason: "end_turn" | "cancelled" }
//       { kind: "stop", reason: "refusal", error: ProviderErrorInfo }
//       { kind: "continue" }
//   - 失败路径（provider 抛错 / 用户 cancel）已在内部吸收，绝不向上抛 ——
//     prompt() 调用方拿到的是 "返回值即结论"
//   - 副作用：可能 push 到 session.history、session.turnUsage、并发出一系列
//     session/update 通知。LLM 调用 + tool 调用之间的顺序与日志严格保留原状
//
// 抽出原因（A2 / PROGRESS Phase A）：旧 InvoxAgent.runOneIteration 是 300+ 行的
// 私有方法，把 agent.ts 撑到 1660 行；提成 free function 后 prompt-loop 模块
// 独立可读、可单测，agent.ts 的类骨架留给 ACP 入口。

import type {
  AgentSideConnection,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";
import { createLogger, preview } from "../log.js";
const log = createLogger("prompt-loop");
import type { LLMMessage, LLMProvider, ParsedToolCall } from "../llm/types.js";
import { createMcpTool } from "../mcp/tool.js";
import {
  runPostToolUse,
  runPostToolUseFailure,
  runPreToolUse,
} from "../plugins/hooks.js";
import { kindFromTier } from "../tools/permissions.js";
import { getTool, TOOL_SPECS } from "../tools/registry.js";
import { executeTool } from "../tools/router.js";
import type { PermissionPolicy, SubAgentRunner } from "../tools/types.js";
import { buildDynamicSubAgentSpec } from "../tools/sub-agent.js";
import {
  classifyProviderError,
  formatProviderErrorForUser,
  type ProviderErrorInfo,
} from "./error-mapping.js";
import { parseToolArguments, safeParseJSON } from "./json.js";
import type { HookBase, Session } from "./session-types.js";
import { thinkingToReasoningEffort } from "./system-prompt.js";
import {
  agentAllowsMcp,
  filterToolSpecsByAgent,
  type AgentTemplate,
} from "./templates.js";
import {
  previewArgs,
  startLocationsFor,
  startTitleFor,
} from "./tool-presentation.js";
import { accumulateTurnUsage } from "./usage-meter.js";

/**
 * runOneIteration 的依赖注入包。InvoxAgent 在每次调用前打包一次，避免
 * 每个参数单独传。
 */
export interface IterationDeps {
  conn: AgentSideConnection;
  provider: LLMProvider;
  clientCaps: ClientCapabilities;
  policy: PermissionPolicy;
  /** session.selectedModel 兜底值（来自 AgentModelConfig.defaultModelId） */
  defaultModelId: string;
  /** 构造 hook context base 字段的回调。InvoxAgent 通过它注入
   *  client / version / transcript_path 等只有 agent 知道的字段。 */
  buildHookBase: (session: Session) => HookBase;
  /**
   * 当前会话激活的 agent 模板（Phase G）。
   *
   *   - undefined → 走旧路径：暴露全部内置工具 + 全部 MCP 工具
   *   - 已设      → 按 agent.tools 过滤内置工具；按 agent.mcp 控制 MCP 暴露
   */
  activeAgent?: AgentTemplate | undefined;
  /**
   * 全部 agent 模板（id → 模板）。SubAgent 工具据此查找 subagent_type。
   *
   * 作为 subagent 启动入口的依赖；空 map / undefined 时 SubAgent 工具会拒绝
   * 启动并返回友好错误。InvoxAgent 在拼装 deps 时直接传入 this.agentById。
   */
  agentRegistry?: ReadonlyMap<string, AgentTemplate>;
  /**
   * 是否处于 subagent 内部（递归屏障）。
   *
   *   - false / undefined（默认）→ 父循环：SubAgent 工具暴露给 LLM
   *   - true                       → subagent 循环：从 toolSpecs 中剔除 SubAgent，
   *                                  且不向 ToolExecContext 注入 subAgentRunner
   *
   * 这一招是双保险：(a) LLM 看不到 SubAgent 工具，自然不会调用；
   * (b) 即便 LLM 凭借训练记忆硬调，runner 缺失会让其失败而非递归爆炸。
   */
  inSubAgent?: boolean;
}

/** runOneIteration 的返回。caller 应不抛异常地处理这三种 case。 */
export type IterationResult =
  | { kind: "stop"; reason: "end_turn" | "cancelled" }
  | { kind: "stop"; reason: "refusal"; error: ProviderErrorInfo }
  | { kind: "continue" };

export interface ToolCallBatch {
  readonly mode: "parallel" | "serial";
  readonly calls: ParsedToolCall[];
}

const NON_PARALLEL_TOOL_NAMES = new Set(["Bash", "Edit"]);

/**
 * 即便 tier 不是 "read" 也强制视为并行安全的工具。
 *
 * SubAgent 是典型例子：它的 tier="execute"（语义上"可以做任何事"），但每个
 * subagent 跑在独立的 history / toolState / abort / turnUsage 里，多个
 * subagent 之间没有共享可变状态 —— 真正"并行不安全"的还是它们内部各自
 * 调到的 Edit / Bash，那一层会被 subagent 自己的 prompt-loop 串行化。
 *
 * 让 SubAgent 在父循环里能并行启动，就能让 LLM 一次性派发多个调研子任务
 * （例：同时跑 Plan + CodeReviewer + Ask），父总耗时 = max(子) 而非 sum(子)。
 */
const PARALLEL_SAFE_OVERRIDE_TOOL_NAMES = new Set(["SubAgent"]);

/** 判断单个工具调用是否允许放入并行批次。 */
export function isParallelSafeToolCall(call: ParsedToolCall): boolean {
  const tool = getTool(call.name);
  if (!tool) return false;
  if (NON_PARALLEL_TOOL_NAMES.has(call.name)) return false;
  if (PARALLEL_SAFE_OVERRIDE_TOOL_NAMES.has(call.name)) return true;
  return tool.tier === "read";
}

/**
 * 按明显顺序依赖把 tool_calls 切成批次。
 *
 * 设计选择：只有内置只读工具可并行；写入/执行类工具、MCP 工具、未知工具都作为
 * 顺序屏障。这样 `Read`/`Glob`/`Grep`/`Skill` 等无明显依赖的调用会并发，
 * `Edit` 与 `Bash` 默认不可并行，`Write`/`MakePlan` 也因会改文件与缓存而串行。
 */
export function planToolCallBatches(
  toolCalls: readonly ParsedToolCall[],
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let parallelCalls: ParsedToolCall[] = [];

  const flushParallel = (): void => {
    if (parallelCalls.length === 0) return;
    batches.push({ mode: "parallel", calls: parallelCalls });
    parallelCalls = [];
  };

  for (const call of toolCalls) {
    if (isParallelSafeToolCall(call)) {
      parallelCalls.push(call);
      continue;
    }

    flushParallel();
    batches.push({ mode: "serial", calls: [call] });
  }

  flushParallel();
  return batches;
}

/**
 * 跑一轮 LLM ↔ tool 往返。
 */
export async function runOneIteration(
  session: Session,
  deps: IterationDeps,
): Promise<IterationResult> {
  let assistantText = "";
  const toolCalls: ParsedToolCall[] = [];
  let finishReason: "stop" | "tool_calls" | "length" | "other" = "other";

  try {
    // 合并 invox 内置工具与本会话 MCP 工具。Phase G：根据当前 agent 模板过滤。
    //   - 内置工具按 agent.tools 白名单 / 黑名单过滤
    //   - MCP 工具按 agent.mcp 开关全 on / 全 off
    // agent 未设（agents 为空，旧路径）→ 全部暴露。

    // 动态生成 SubAgent 工具描述：将占位符替换为实际加载的 agent 类型列表。
    // 这样项目级/用户级自定义的 agent 都能自动出现在提示词中，
    // LLM 能看到真实可用的 subagent_type 选项。
    let baseToolSpecs = TOOL_SPECS;
    if (deps.agentRegistry && deps.agentRegistry.size > 0) {
      const dynamicSubAgentSpec = buildDynamicSubAgentSpec(deps.agentRegistry);
      baseToolSpecs = TOOL_SPECS.map((spec) =>
        spec.function.name === "SubAgent" ? dynamicSubAgentSpec : spec,
      );
    }

    let builtinSpecs = filterToolSpecsByAgent(
      baseToolSpecs,
      deps.activeAgent?.tools,
    );
    // 递归屏障：subagent 内部强制剔除 SubAgent 工具，无视 agent.tools 是否
    // 显式列入。这条 belt-and-suspenders 保证再激进的 agent 模板也无法
    // 嵌套启动 subagent。
    if (deps.inSubAgent) {
      builtinSpecs = builtinSpecs.filter(
        (s) => s.function.name !== "SubAgent",
      );
    }
    const mcpSpecs = agentAllowsMcp(deps.activeAgent)
      ? (session.mcpClient?.getToolSpecs() ?? [])
      : [];
    const allTools =
      mcpSpecs.length > 0 ? [...builtinSpecs, ...mcpSpecs] : builtinSpecs;

    for await (const delta of deps.provider.stream({
      messages: session.history,
      signal: session.abort.signal,
      tools: allTools,
      model: session.selectedModel ?? deps.defaultModelId,
      reasoningEffort: thinkingToReasoningEffort(session.configValues.thinking),
    })) {
      if (session.abort.signal.aborted) break;
      switch (delta.kind) {
        case "text":
          if (delta.text.length > 0) {
            assistantText += delta.text;
            await deps.conn.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta.text },
              },
            });
          }
          break;
        case "tool_call":
          toolCalls.push(delta.call);
          break;
        case "usage":
          accumulateTurnUsage(session.turnUsage, delta.usage);
          break;
        case "finish":
          finishReason = delta.reason;
          break;
      }
    }
  } catch (err) {
    // 把 provider 抛出的错误映射到 ACP stopReason。
    // AbortError 是用户主动取消，走 cancelled；其它统一 refusal，并通过
    // agent_message_chunk 把可读 message 流给用户 —— 不再向 RPC 抛异常。
    const classified = classifyProviderError(err);
    if (classified.kind === "abort") {
      if (assistantText)
        session.history.push({ role: "assistant", content: assistantText });
      return { kind: "stop", reason: "cancelled" };
    }
    const info = classified.info;
    log.error("provider stream failed", {
      category: info.category,
      ...(info.status !== undefined ? { status: info.status } : {}),
      ...(info.code !== undefined ? { code: info.code } : {}),
      message: info.message,
    });
    // 已经流出来过部分文字时先存进 history，避免上下文丢失
    if (assistantText)
      session.history.push({ role: "assistant", content: assistantText });
    // 把错误说给用户听
    try {
      await deps.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatProviderErrorForUser(info) },
        },
      });
    } catch {
      // 写错误信息本身也可能失败（连接已断）—— 静默忽略，stopReason 仍会回报
    }
    return { kind: "stop", reason: "refusal", error: info };
  }

  if (session.abort.signal.aborted) {
    if (assistantText)
      session.history.push({ role: "assistant", content: assistantText });
    return { kind: "stop", reason: "cancelled" };
  }

  if (toolCalls.length === 0 || finishReason !== "tool_calls") {
    session.history.push({ role: "assistant", content: assistantText });
    return { kind: "stop", reason: "end_turn" };
  }

  session.history.push({
    role: "assistant",
    content: assistantText,
    tool_calls: toolCalls,
  });

  await executeToolCallBatches(toolCalls, session, deps);

  return { kind: "continue" };
}

/** 按批次执行工具调用，并保证写入 history 的 tool message 顺序与 LLM 输出一致。 */
async function executeToolCallBatches(
  toolCalls: readonly ParsedToolCall[],
  session: Session,
  deps: IterationDeps,
): Promise<void> {
  const batches = planToolCallBatches(toolCalls);
  for (const batch of batches) {
    if (batch.mode === "parallel") {
      log.info("tool batch start", {
        mode: "parallel",
        count: batch.calls.length,
        names: batch.calls.map((call) => call.name),
      });
      session.sessionLog?.write(
        `[parallel x${batch.calls.length}: ${batch.calls.map((c) => c.name).join(", ")}]\n`,
      );
      const messages = await Promise.all(
        batch.calls.map((call) => runOneToolCall(call, session, deps)),
      );
      session.history.push(...messages);
      continue;
    }

    const call = batch.calls[0];
    if (!call) continue;
    session.history.push(await runOneToolCall(call, session, deps));
  }
}

/**
 * 处理单个 tool_call —— 解析参数 → PreToolUse hook → 执行 → Post hook →
 * emit tool_call_update + 返回结果消息，调用方负责按批次顺序写入 history。
 *
 * 抽出来主要是为了把 runOneIteration 的体量再压一档。
 * 失败路径自吞，不向调用方抛错（与原实现一致）。
 */
async function runOneToolCall(
  call: ParsedToolCall,
  session: Session,
  deps: IterationDeps,
): Promise<LLMMessage> {
  const tool = getTool(call.name);
  const mcpTool =
    !tool && call.name.startsWith("mcp__")
      ? session.mcpClient?.getMcpTool(call.name)
      : undefined;
  const startKind = mcpTool
    ? ("execute" as const)
    : tool
      ? (tool.uiKind ?? kindFromTier(tool.tier))
      : ("other" as const);
  const startTitle = startTitleFor(call);
  const startLocations = startLocationsFor(call);

  await deps.conn.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: call.id,
      title: startTitle,
      kind: startKind,
      status: "in_progress",
      rawInput: safeParseJSON(call.arguments) ?? { raw: call.arguments },
      ...(startLocations ? { locations: startLocations } : {}),
    },
  });

  log.info("tool start", {
    name: call.name,
    toolCallId: call.id,
    argsPreview: previewArgs(call.arguments),
  });
  session.sessionLog?.write(
    `> ${call.name}: ${previewArgs(call.arguments)}\n`,
  );
  const toolStartedAt = Date.now();

  // 工具参数解析（容错版）：旧实现用裸 JSON.parse(call.arguments)，
  // 一个畸形 JSON 就能挂掉整个 prompt loop。改为：解析失败 → emit failed
  // update + 写一条 error tool message 给 LLM 自我纠错 + return 继续下一个 tool_call。
  const argsResult = parseToolArguments(call.arguments);
  if (!argsResult.ok) {
    log.warn("tool args parse failed", {
      name: call.name,
      toolCallId: call.id,
      error: argsResult.error,
    });
    await deps.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: call.id,
        status: "failed",
        title: `${call.name} (bad arguments)`,
        kind: startKind,
        content: [
          {
            type: "content",
            content: { type: "text", text: argsResult.error },
          },
        ],
      },
    });
    return {
      role: "tool",
      tool_call_id: call.id,
      content: argsResult.error,
      name: call.name,
    };
  }
  const toolArgs: Record<string, unknown> = argsResult.value;

  // PreToolUse hook
  const preResult = await runPreToolUse(session.hooks, {
    hook_event_name: "PreToolUse",
    ...deps.buildHookBase(session),
    tool_name: call.name,
    tool_input: toolArgs,
  });

  if (!preResult.allow) {
    // hook 拒绝了 —— emit denied 状态
    const reason =
      preResult.reason ?? `Tool "${call.name}" blocked by plugin hook.`;
    await deps.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: call.id,
        status: "failed",
        title: `${call.name} (blocked by hook)`,
        kind: startKind,
        content: [{ type: "content", content: { type: "text", text: reason } }],
      },
    });
    return {
      role: "tool",
      tool_call_id: call.id,
      content: reason,
      name: call.name,
    };
  }

  // hook 返回了 modifiedInput —— 合并到 toolArgs（如 PreToolUse inject-env
  // 在 Bash 命令前注入 export 环境变量）。采用浅合并：hook 返回的字段覆盖
  // 原始参数中同名字段，其余保持不变。
  // 同时保存修改前的快照到 originalInput，让工具（如 Bash）在 UI 展示
  // 中使用用户原始命令，而非被 hook 改写后的冗长 export 前缀。
  let originalInput: Record<string, unknown> | undefined;
  if (preResult.modifiedInput) {
    // 仅当有实际变更时才保存快照，避免无意义的对象分配
    originalInput = { ...toolArgs };
    for (const [k, v] of Object.entries(preResult.modifiedInput)) {
      toolArgs[k] = v;
    }
    log.info("PreToolUse: applied modifiedInput", {
      tool: call.name,
      keys: Object.keys(preResult.modifiedInput),
    });
  }

  // ToolExecContext 共用部分 —— 两条分支（MCP / 内置）都用同一份。
  // SubAgent 工具会读 ctx.subAgentRunner；其它工具应忽略。
  // 递归屏障：subagent 内部不注入 runner，让 SubAgent 工具直接 fail-fast。
  const baseExecCtx = {
    conn: deps.conn,
    sessionId: session.id,
    cwd: session.cwd,
    caps: deps.clientCaps,
    signal: session.abort.signal,
    policy: deps.policy,
    toolCallId: call.id,
    state: session.toolState,
    activeAgentId: deps.activeAgent?.id,
    ...(originalInput ? { originalInput } : {}),
    ...(deps.inSubAgent
      ? {}
      : { subAgentRunner: makeSubAgentRunner(session, deps) }),
  };

  const r = mcpTool
    ? await createMcpTool(mcpTool, session.mcpClient!).execute(
        toolArgs,
        baseExecCtx,
      )
    : await executeTool(call.name, JSON.stringify(toolArgs), baseExecCtx);

  const elapsedMs = Date.now() - toolStartedAt;
  // 回填到 call 对象（与 history 中 assistant.tool_calls 是同一引用）
  call.ok = r.ok;
  call.elapsedMs = elapsedMs;
  log.info("tool end", {
    name: call.name,
    toolCallId: call.id,
    ok: r.ok,
    elapsedMs,
    resultBytes: r.resultText.length,
    resultPreview:
      r.resultText.length > 200
        ? r.resultText.slice(0, 200) +
          ` …(+${r.resultText.length - 200} more bytes)`
        : r.resultText,
  });
  session.sessionLog?.write(
    `. ${call.name}: ${r.ok ? "ok" : "fail"}` +
      `  (${elapsedMs}ms)  ${preview(r.resultText, 150)}\n`,
  );

  // PostToolUse / PostToolUseFailure hook
  if (r.ok) {
    const postResult = await runPostToolUse(session.hooks, {
      hook_event_name: "PostToolUse",
      ...deps.buildHookBase(session),
      tool_name: call.name,
      tool_input: toolArgs,
      tool_response: r.resultText,
    });
    if (postResult.systemMessage) {
      r.resultText += "\n\n" + postResult.systemMessage;
      r.acpContent = [
        ...r.acpContent,
        {
          type: "content",
          content: {
            type: "text",
            text: "\n\n" + postResult.systemMessage,
          },
        },
      ];
    }
  } else {
    const postResult = await runPostToolUseFailure(session.hooks, {
      hook_event_name: "PostToolUseFailure",
      ...deps.buildHookBase(session),
      tool_name: call.name,
      tool_input: toolArgs,
      tool_response: r.resultText,
    });
    if (postResult.systemMessage) {
      r.resultText += "\n\n" + postResult.systemMessage;
      r.acpContent = [
        ...r.acpContent,
        {
          type: "content",
          content: {
            type: "text",
            text: "\n\n" + postResult.systemMessage,
          },
        },
      ];
    }
  }

  await deps.conn.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: call.id,
      status: r.ok ? "completed" : "failed",
      title: r.title,
      kind: r.kind,
      content: r.acpContent,
      ...(r.locations ? { locations: r.locations } : {}),
    },
  });

  return {
    role: "tool",
    tool_call_id: call.id,
    content: r.resultText,
    name: call.name,
  };
}

/**
 * 构造一个绑定到当前父 session + IterationDeps 的 SubAgent 启动闭包。
 *
 * 工厂模式而非全局函数：闭包捕获 session（取 cwd / mcpClient / hooks /
 * abort / turnUsage 合并）与 deps（取 provider / clientCaps / policy /
 * defaultModelId / buildHookBase / agentRegistry）；从 ToolExecContext
 * 视角看，subAgentRunner 只是个"接受 SubAgentRunRequest 返回结果"的纯函数。
 *
 * 动态 import sub-agent-runner 是不必要的（无循环依赖：sub-agent-runner →
 * prompt-loop 是单向引用，prompt-loop → sub-agent-runner 也是单向）。但为了
 * 避免「import 时自身评估」造成的隐性环（agent.ts → prompt-loop.ts →
 * sub-agent-runner.ts → prompt-loop.ts），这里用 lazy 顶层 import 而非
 * 在 makeSubAgentRunner 体内 require —— 都是 ESM，标准 import 即可。
 */
function makeSubAgentRunner(
  parent: Session,
  parentDeps: IterationDeps,
): SubAgentRunner {
  return async (req, signal) => {
    // 延迟到调用时再 import，规避静态分析层面的潜在循环依赖（v1 防御性写法）
    const { runSubAgent } = await import("./sub-agent-runner.js");
    return runSubAgent({ parentDeps, parent }, req, signal);
  };
}
