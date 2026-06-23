// SubAgent runner —— 启动一个嵌套的 prompt loop，跑一份指定 agent 模板。
//
// 设计契约：
//   - 入口 runSubAgent(deps, opts, signal) 返回 SubAgentRunResult，**永不抛错**：
//     unknown agent / empty prompt / provider 失败 / cancel 全部映射为 result
//   - subagent 共享 parent 的 cwd / mcpClient / hooks —— 同 cwd 下 MCP 池只起
//     一份；hooks 是项目级配置，subagent 也应受同样约束
//   - subagent 拥有独立的 history / toolState / turnUsage / abort：互不污染
//   - **subagent 的 token 消耗不累加进 parent.turnUsage**：父 turnUsage 的语义是
//     "父 turn 单次 LLM 调用的 prompt_tokens 峰值（maxPrompt）"——用于估算
//     "距离父 context window 还有多远"。subagent 在自己独立的 history 里跑，
//     不占父 context，累加会让 UI token chip 虚高。
//   - **包装 conn 全量静默**：subagent 内部任何 session/update 都不向父 UI 转发，
//     UI 上只看到父发出的"SubAgent"工具卡，subagent 内部的 Read/Glob/Grep/Edit
//     等子工具卡都不冒泡 —— 父对话面板保持干净。所有静默的事件都按时间序写入
//     subagent 自己的日志文件，方便事后排查
//   - **每个 subagent 一个独立日志文件**：写到 <cwd>/.invox/logs/，文件名含
//     parent session id + run id + 时间戳。失败仅 warn，主流程不挂
//   - **多 subagent 并行**：同一父 turn 内的多个 SubAgent tool_call 由
//     prompt-loop 的并行批次调度（PARALLEL_SAFE_OVERRIDE_TOOL_NAMES），父
//     prompt-loop 会 Promise.all 等全部完成才进下一轮
//   - subagent 内部禁止再启动 subagent（递归屏障在 prompt-loop 处实现：
//     inSubAgent=true 时 ToolExecContext.subAgentRunner=undefined）
//
// 不在本文件做的事：
//   - 任何 ACP 协议入口（initialize / newSession 等）—— 这是工具层调用
//   - 持久化 —— subagent 的 history 不写盘，turn 结束就丢
//   - 模板加载 —— 上游已经把 agentRegistry 准备好传进来

import { randomUUID } from "node:crypto";
import {
  createLogger,
  openSessionLogFile,
  preview,
} from "../../log.js";
const log = createLogger("sub-agent");
import { runOneIteration, type IterationDeps } from "../prompt-loop.js";
import { createSession } from "../session-factory.js";
import type { Session } from "../session-types.js";
import { systemMessageWithMemoryAndSkills } from "../system-prompt.js";
import { resolveAgentModel } from "../templates/index.js";

// Sub-modules
import {
  subAgentMaxIterations,
  lastAssistantText,
  collectAssistantText,
  ts,
} from "./iterations.js";
import { makeProgressEmitter, type ProgressEmitter } from "./progress-emitter.js";
import { wrapConnForSubAgent } from "./conn-wrapper.js";

// ── 输入输出类型 ──────────────────────────────────────────────────────

export interface SubAgentDeps {
  /**
   * 父 prompt loop 的 IterationDeps 拷贝。runSubAgent 会派生一份新的 deps
   * （覆盖 conn / activeAgent / inSubAgent），保留 provider / clientCaps /
   * policy / defaultModelId / buildHookBase / agentRegistry 不变。
   */
  parentDeps: IterationDeps;
  /** 父 session —— 用来取 cwd / mcpClient / hooks / abort。 */
  parent: Session;
}

export interface SubAgentRunOptions {
  subagentType: string;
  prompt: string;
  description?: string;
  modelOverride?: string;
  /**
   * 父 SubAgent tool_call 的 id —— 用来在跑的过程中向"父工具卡"实时追加进度行。
   * 由 SubAgent 工具从 ToolExecContext.toolCallId 透传。缺省时 runner 不发进度更新。
   */
  parentToolCallId?: string;
}

export interface SubAgentRunResult {
  ok: boolean;
  finalText: string;
  stopReason: "end_turn" | "max_turn_requests" | "refusal" | "cancelled";
  iterations: number;
  /** 本次运行的独立日志文件绝对路径；写入失败时为 undefined。 */
  logPath?: string;
  /** 本次运行耗时毫秒数；供 tools/sub-agent.ts 构建 banner 文本。 */
  elapsedMs: number;
  /** subagent 的 LLM input tokens。 */
  input: number;
  /** subagent 的 LLM output tokens。 */
  output: number;
  /** subagent 的 LLM total tokens（input + output）。 */
  total: number;
  /** 进度轨迹累计行（runner 已发完最后一帧；调用方可作为 audit trail 渲染）。 */
  progressLines?: string[];
  error?: string;
}

// ── 主入口 ────────────────────────────────────────────────────────────

/**
 * 跑一个 subagent。详细契约见文件头。
 */
export async function runSubAgent(
  deps: SubAgentDeps,
  opts: SubAgentRunOptions,
  signal: AbortSignal,
): Promise<SubAgentRunResult> {
  const { parentDeps, parent } = deps;

  // 1. 校验：注册表 + 模板 + prompt
  const registry = parentDeps.agentRegistry;
  if (!registry || registry.size === 0) {
    return badResult(
      "no agent templates loaded; SubAgent is unavailable in this environment.",
    );
  }
  const template = registry.get(opts.subagentType);
  if (!template) {
    const available = [...registry.keys()].join(", ");
    return badResult(
      `unknown subagent_type "${opts.subagentType}" (available: ${available || "<none>"}).`,
    );
  }
  if (!opts.prompt || !opts.prompt.trim()) {
    return badResult("missing 'prompt' (subagent needs a non-empty task).");
  }

  // 2. 解析 model：modelOverride > template.model > parent.selectedModel
  const fallbackModel = parent.selectedModel ?? parentDeps.defaultModelId;
  const resolvedModel =
    opts.modelOverride ??
    (template.model
      ? resolveAgentModel(template.model, fallbackModel)
      : fallbackModel);

  // 3. 开日志文件 —— 每个 subagent 一个独立文件（按 runId 区分）
  const runId = randomUUID();
  const logFile = openSessionLogFile(parent.cwd, parent.id, "subagent", {
    fileNameFn: (base) => {
      const safeParent = base.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeRun = runId.slice(0, 8);
      const tsFmt = new Date().toISOString().replace(/[:.]/g, "-");
      return `subagent-${safeParent}-${safeRun}-${tsFmt}`;
    },
  });
  const startedAt = Date.now();
  logFile.write(
    `${ts()} ── subagent start ────────────────────────────────────────\n` +
      `${ts()}   subagent_type: ${opts.subagentType}\n` +
      `${ts()}   description:   ${opts.description ?? "(none)"}\n` +
      `${ts()}   model:         ${resolvedModel}\n` +
      `${ts()}   parent.id:     ${parent.id}\n` +
      `${ts()}   parent.cwd:    ${parent.cwd}\n` +
      `${ts()}   runId:         ${runId}\n` +
      `${ts()}   prompt: ${preview(opts.prompt, 500)}\n`,
  );

  // 4. 构造 sub-Session
  //
  // abort 链路：父 abort 与传入的 signal 任意一方触发，subagent 立即停止。
  // 反向不传播：subagent 自然结束不会取消父任务。
  const subAbort = new AbortController();
  const onParentAbort = (): void => {
    if (!subAbort.signal.aborted) subAbort.abort();
  };
  if (parent.abort.signal.aborted) {
    subAbort.abort();
  } else {
    parent.abort.signal.addEventListener("abort", onParentAbort, {
      once: true,
    });
  }
  if (signal.aborted) {
    subAbort.abort();
  } else {
    signal.addEventListener("abort", onParentAbort, { once: true });
  }

  // 共享 parent.id —— hooks / requestPermission 等 ACP 路径需要拿到 sessionId，
  // subagent 复用父的让客户端识别它们属于同一会话。但所有 sessionUpdate 通知
  // 都被 wrapConnForSubAgent 静默掉，UI 不会被打扰。
  const sub = createSession({
    id: parent.id,
    cwd: parent.cwd,
    history: [
      systemMessageWithMemoryAndSkills(template.prompt, parent.cwd),
      { role: "user", content: opts.prompt },
    ],
    abort: subAbort,
    hooks: parent.hooks,
    // 共享 MCP —— 同一 cwd 下进程池只有一份
    mcpClient: parent.mcpClient,
    selectedModel: resolvedModel,
    // thinking 沿用父配置；不暴露 agent / system_prompt / model 等下拉态
    configValues: { thinking: parent.configValues["thinking"] ?? "off" },
  });
  sub.turnStartedAt = Date.now();

  // 5. 派生 sub IterationDeps：覆盖 conn / activeAgent / inSubAgent
  //
  // 进度回流：当父 SubAgent 工具有 toolCallId 时，构造 progress emitter，把
  // 「subagent 内部每发起一个 inner tool_call」实时回流到父工具卡的 content
  // —— 用未经 wrap 的原 conn（parentDeps.conn）发，避免被 wrappedConn 静默掉。
  const progress: ProgressEmitter | undefined = opts.parentToolCallId
    ? makeProgressEmitter(
        parentDeps.conn,
        parent.id,
        opts.parentToolCallId,
        logFile.path || undefined,
      )
    : undefined;

  const wrappedConn = wrapConnForSubAgent(parentDeps.conn, logFile, progress);
  const subDeps: IterationDeps = {
    ...parentDeps,
    conn: wrappedConn,
    activeAgent: template,
    inSubAgent: true,
  };

  // 6. 跑 prompt loop
  //
  // 每轮 iter 后捕获 sub.history 在本轮新增的 assistant 文本，单行写入日志。
  const max = subAgentMaxIterations();
  let stopReason: SubAgentRunResult["stopReason"] = "max_turn_requests";
  let iterations = 0;
  let runError: string | undefined;
  try {
    for (let i = 0; i < max; i++) {
      iterations += 1;
      if (sub.abort.signal.aborted) {
        stopReason = "cancelled";
        logFile.write(
          `${ts()}   iter ${iterations}: cancelled (abort signal)\n`,
        );
        break;
      }
      logFile.write(`${ts()}   iter ${iterations}: start\n`);
      const histLenBefore = sub.history.length;
      const result = await runOneIteration(sub, subDeps);

      const newAssistantText = collectAssistantText(
        sub.history.slice(histLenBefore),
      );
      if (newAssistantText) {
        logFile.write(
          `${ts()}   iter ${iterations}: assistant_text=${preview(newAssistantText, 500)}\n`,
        );
      }

      if (result.kind === "stop") {
        stopReason = result.reason;
        if (result.reason === "refusal") {
          runError = result.error.message;
          logFile.write(
            `${ts()}   iter ${iterations}: stop refusal — ${runError}\n`,
          );
        } else {
          logFile.write(
            `${ts()}   iter ${iterations}: stop ${result.reason}\n`,
          );
        }
        break;
      }
      logFile.write(`${ts()}   iter ${iterations}: continue\n`);
    }
  } catch (e) {
    stopReason = "refusal";
    runError = e instanceof Error ? e.message : String(e);
    log.warn("subagent: unexpected error caught", {
      subagentType: opts.subagentType,
      error: runError,
    });
    logFile.write(`${ts()}   unexpected error: ${runError}\n`);
  } finally {
    parent.abort.signal.removeEventListener("abort", onParentAbort);
    signal.removeEventListener("abort", onParentAbort);
  }

  // 7. 抓取最终输出文本 + 写收尾日志 + 关流
  const finalText = lastAssistantText(sub.history);
  const elapsedMs = Date.now() - startedAt;

  logFile.write(
    `${ts()} ── subagent done ─────────────────────────────────────────\n` +
      `${ts()}   stopReason:    ${stopReason}\n` +
      `${ts()}   iterations:    ${iterations}\n` +
      `${ts()}   elapsedMs:     ${elapsedMs}\n` +
      `${ts()}   sub.input:     ${sub.turnUsage.input}\n` +
      `${ts()}   sub.output:    ${sub.turnUsage.output}\n` +
      `${ts()}   sub.calls:     ${sub.turnUsage.calls}\n` +
      `${ts()}   finalText:     ${preview(finalText, 1000)}\n`,
  );
  logFile.close();

  log.info("subagent done", {
    subagentType: opts.subagentType,
    model: resolvedModel,
    iterations,
    stopReason,
    finalLen: finalText.length,
    elapsedMs,
    subInput: sub.turnUsage.input,
    subOutput: sub.turnUsage.output,
    logPath: logFile.path || undefined,
  });

  // 8. banner 文本由 tools/sub-agent.ts 在 tool_call_update completed 时拼入
  //    acpContent —— 不再通过 agent_thought_chunk 发送，避免多个并行 SubAgent
  //    的 banner 在 Zed "Thinking" 块里叠成一坨。

  return {
    ok: stopReason === "end_turn",
    finalText,
    stopReason,
    iterations,
    elapsedMs,
    input: sub.turnUsage.input,
    output: sub.turnUsage.output,
    total: sub.turnUsage.total,
    ...(logFile.path ? { logPath: logFile.path } : {}),
    ...(progress ? { progressLines: [...progress.lines()] } : {}),
    ...(runError ? { error: runError } : {}),
  };
}

// ── 辅助 ──────────────────────────────────────────────────────────────

function badResult(msg: string): SubAgentRunResult {
  return {
    ok: false,
    finalText: "",
    stopReason: "refusal",
    iterations: 0,
    elapsedMs: 0,
    input: 0,
    output: 0,
    total: 0,
    error: msg,
  };
}
