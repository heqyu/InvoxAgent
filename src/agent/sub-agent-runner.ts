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
  formatTimestamp,
  openSessionLogFile,
  preview,
  type LogFile,
} from "../log.js";
const log = createLogger("sub-agent");
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { LLMMessage } from "../llm/types.js";
import { runOneIteration, type IterationDeps } from "./prompt-loop.js";
import { createSession } from "./session-factory.js";
import type { Session } from "./session-types.js";
import { systemMessageWithMemoryAndSkills } from "./system-prompt.js";
import { resolveAgentModel } from "./templates.js";
import { humanizeTokens } from "./token-meter.js";
import { maxIterations as parentMaxIterations } from "./agent-helpers.js";

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

// ── 配置常量 ──────────────────────────────────────────────────────────

/**
 * subagent 单次跑的最大迭代次数。比父 loop 默认 50 更紧 —— subagent 是
 * "委派子任务"，不应该耗光父 turn 的预算。
 */
const SUBAGENT_MAX_ITERATIONS_FALLBACK = 25;

/**
 * subagent 迭代上限：
 *   - INVOX_SUBAGENT_MAX_ITERATIONS env 显式指定时优先（≥1 的整数）
 *   - 否则取 min(父 loop 上限, SUBAGENT_MAX_ITERATIONS_FALLBACK)
 */
function subAgentMaxIterations(): number {
  const raw = process.env["INVOX_SUBAGENT_MAX_ITERATIONS"];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.min(parentMaxIterations(), SUBAGENT_MAX_ITERATIONS_FALLBACK);
}

// ── 日志文件 ──────────────────────────────────────────────────────────
// subagent 日志通过 openSessionLogFile + 自定义 fileNameFn 生成，
// 不再自己 openSync/mkdirSync（J1.3 合并进 log.ts）。

// 时间戳前缀（本地时间）—— 复用 log.ts 的 formatTimestamp，
// 与主 session 日志格式统一。
function ts(): string {
  return formatTimestamp(new Date());
}

// ── 进度回流（实时更新父 SubAgent 工具卡的 content）────────────────────

/**
 * subagent 跑过程中"父工具卡"的实时进度回流。
 *
 * 工作机制：
 *   - 每当 wrapped conn 拦截到一条 inner `tool_call` 通知，就抽出 title 字段
 *     追加一行 `▸ <Title>` 到内部 lines 列表
 *   - 每次追加都立刻通过**未经 wrap 的原 conn** 发一条 `tool_call_update`，
 *     toolCallId = 父 SubAgent tool_call 的 id；只更新 `content` 字段，不动
 *     `status`/`title`/`kind`（让 ACP 客户端做 partial merge），父卡保持
 *     in_progress 状态，直到父 prompt-loop 在 subagent 收尾后发末态 update
 *   - lines[0] 永远是 `Log: <path>` —— 用户能从 UI 卡片直接看到独立日志位置
 *
 * **只更新工具卡 content，不发 thinking chunk**。Banner 摘要（token/time/stop）
 * 由 tools/sub-agent.ts 在 tool_call_update completed 时拼入 acpContent，
 * 避免多个并行 SubAgent 的 banner 在 Zed "Thinking" 块里叠成一坨。
 *
 * 节流：暂不做。tool_call 是稀疏事件（每秒至多几个），1:1 emit 可接受；
 * 真有抖动再加 200ms debounce。
 *
 * 失败容错：sessionUpdate 抛错全吞掉 —— 进度回流是 nice-to-have，挂掉也不能
 * 让 subagent 主流程跟着挂。
 */
interface ProgressEmitter {
  recordInnerToolCall(title: string): void;
  /** 把 final 的 progressLines（含 Log 行 + 所有 ▸ 行）暴露给 caller。 */
  lines(): readonly string[];
}

function makeProgressEmitter(
  conn: AgentSideConnection,
  sessionId: string,
  parentToolCallId: string,
  logPath: string | undefined,
): ProgressEmitter {
  const lines: string[] = [];
  if (logPath) lines.push(`Log: ${logPath}`);
  lines.push("▸ subagent started");

  // 起手立刻发一帧 card update，让用户立即看到日志路径 + "started" 行
  void emitCardUpdate();

  function renderCard(): string {
    // 进度行用 markdown 强换行（行尾两空格 + \n）让 Zed 真的一行一行渲染。
    // 单个 `\n` 在 markdown 里是 soft break（同段落空格），整段 ▸ 行会被挤
    // 成一坨可读性极差。两空格 + \n 是 markdown 标准的"hard line break"。
    return lines.join("  \n");
  }

  async function emitCardUpdate(): Promise<void> {
    try {
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: parentToolCallId,
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: renderCard() },
            },
          ],
        },
      });
    } catch {
      // 进度回流失败吞掉 —— 主流程不挂
    }
  }

  return {
    recordInnerToolCall: (title: string) => {
      lines.push(`▸ ${title}`);
      void emitCardUpdate();
    },
    lines: () => lines.slice(),
  };
}

// ── 退出 banner 文本（供 tools/sub-agent.ts 拼入工具卡 acpContent）────────

/**
 * 构建 subagent 收尾 banner 纯文本。
 *
 * 从 agent_thought_chunk 迁移到工具卡 acpContent：当多个 SubAgent 并行完成
 * 时，Zed 把所有 agent_thought_chunk 合并进同一个 "Thinking" 块，banner 互相
 * 叠加不可读。放到各自工具卡的 completed content 里，天然分离且信息不丢。
 */
export function buildSubAgentBanner(opts: {
  subagentType: string;
  stopReason: SubAgentRunResult["stopReason"];
  iterations: number;
  elapsedMs: number;
  input: number;
  output: number;
  total: number;
  logPath?: string;
  error?: string;
}): string {
  const elapsedSec = (opts.elapsedMs / 1000).toFixed(1);
  const lines: string[] = [
    `🤖 SubAgent ${opts.subagentType} · ${opts.iterations} iter · ${elapsedSec}s · stop=${opts.stopReason}`,
    `🪙 in ${humanizeTokens(opts.input)} → out ${humanizeTokens(opts.output)} (${humanizeTokens(opts.total)} total)`,
  ];
  if (opts.error) {
    lines.push(`❌ ${preview(opts.error, 200)}`);
  }
  if (opts.logPath) {
    lines.push(`📁 ${opts.logPath}`);
  }
  // 两空格 + \n 强换行，让 Zed markdown 逐行渲染（单 \n 是 soft break）
  return lines.join("  \n");
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
  // 这是替代「逐 token agent_message_chunk」的精简方案：每 iter 一行 ≪ per-token
  // 1400+ 行，但仍能让 audit 看到"subagent 这一轮说了啥"。
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

      // 捕捉本轮新追加的 assistant 文本（runOneIteration 在 iter 末尾会
      // push 一条 {role:"assistant", content:string, [tool_calls]?}）
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
    // runOneIteration 设计上不抛，但 hooks / 写入失败仍可能漏到这里。
    // 全部映射为 refusal —— 与 prompt() 顶层 catch 同一策略。
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

/**
 * 取 history 末尾最后一条 assistant 文本消息。
 *
 * - subagent 收尾时 prompt-loop 会 push 一条 `{role:"assistant", content:string}`
 * - tool_calls 残留行（content 通常为空）也是 assistant，但其 content 大概率
 *   是空串；这里取"最后一条 string content"避免把 tool_calls 那条当成文本输出
 * - 找不到时返回空串，调用方负责给出兜底文案
 */
function lastAssistantText(history: readonly LLMMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/**
 * 把 history 切片中所有 assistant 消息的 string content 串起来。
 *
 * 用途：iter 末尾把"本轮新增的 assistant 文本"合并成一行写日志，替代
 * per-token agent_message_chunk 的逐条记录。
 *
 * 同一 iter 通常只有 1 条 assistant 消息（含 tool_calls 的也算 1 条），
 * 但保险起见用循环聚合 —— 防止 prompt-loop 未来插入额外 assistant 消息时
 * 漏记。
 */
function collectAssistantText(slice: readonly LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of slice) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content) {
      parts.push(m.content);
    }
  }
  return parts.join("\n");
}

/**
 * 抽出一条 SessionNotification 的可读摘要，写到 subagent 日志文件。
 *
 * 设计点：
 *   - 每条 update 一行，便于 grep "tool_call" 之类
 *   - 截短长字段（content / title），保留事件结构信息为主
 *   - 不识别的 sessionUpdate kind 直接 JSON 化前 200 字符（forward-compat）
 *
 * 注意：调用前应先用 shouldLogNotif 过滤掉 chunk / 中间态等噪音事件。
 */
function summarizeNotif(n: SessionNotification): string {
  const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
  const kind = u.sessionUpdate;
  switch (kind) {
    case "tool_call": {
      const id = u["toolCallId"];
      const title = u["title"];
      const k = u["kind"];
      return `tool_call id=${id} kind=${k} title="${preview(String(title ?? ""), 120)}"`;
    }
    case "tool_call_update": {
      const id = u["toolCallId"];
      const status = u["status"];
      const title = u["title"];
      return `tool_call_update id=${id} status=${status} title="${preview(String(title ?? ""), 120)}"`;
    }
    default: {
      // 仅作为兜底（shouldLogNotif 已经过滤掉所有显式无意义 kind）
      const j = JSON.stringify(u);
      return `${kind} ${preview(j, 200)}`;
    }
  }
}

/**
 * 决定一条 SessionNotification 是否值得写到 subagent 独立日志。
 *
 * 噪音过滤策略（实测：典型 12 iter subagent 共 1531 条 notif，过滤后剩 ~80）：
 *
 *   - **agent_message_chunk / agent_thought_chunk**：丢
 *     一次 LLM 流响应就有几百条 per-token chunk，对调试 subagent 行为意义不大；
 *     完整文本由 runner 在每 iter 末尾另写一行 "iter N: assistant_text=..." 兜底
 *
 *   - **tool_call_update with status="in_progress"**：丢
 *     工具执行中可能多次发 in_progress 帧（streaming output），只有 completed /
 *     failed / cancelled 这种**终态**才有信号
 *
 *   - **usage_update**：丢
 *     subagent done banner 已经把 input/output/calls 数字写出来了；逐次发反而冗余
 *
 *   - **plan / available_commands_update**：丢
 *     subagent 内部不会改 plan、不重新发命令列表
 *
 *   - **tool_call（启动）+ 终态 tool_call_update**：保留 —— 这是排查"subagent 跑
 *     了哪些工具 / 哪个失败了"的核心信号
 *
 *   - **未识别 kind**：保留 —— forward-compat，新协议事件先记下来再说
 */
function shouldLogNotif(n: SessionNotification): boolean {
  const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    return false;
  }
  if (kind === "usage_update") return false;
  if (kind === "plan" || kind === "available_commands_update") return false;
  if (kind === "tool_call_update") {
    const status = u["status"];
    // 仅保留终态；in_progress / pending / 缺失都视作中间态丢弃
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }
  return true;
}

/**
 * 给 subagent 用的 conn 包装层。
 *
 * 转发规则：
 *   - 所有 sessionUpdate **完全静默**，不再向父 UI 转发；改为按时间序写到
 *     subagent 自己的日志文件。这样父对话面板上只看到一张"SubAgent"工具卡，
 *     子工具卡（Read/Glob/Edit/...）/ subagent 的对话流 / usage 全部"折叠"
 *     在卡内（视觉上 = 隐藏；实际 = 写到日志）
 *   - 但当 progress emitter 注入时，inner `tool_call` 通知会被旁路到 emitter，
 *     由它通过未经 wrap 的原 conn 发 `tool_call_update` 更新父 SubAgent 卡的
 *     content，让用户看到实时进度行
 *   - 非 sessionUpdate 方法（readTextFile / writeTextFile / requestPermission
 *     / sessionUpdateExt 等）原样转发到原 conn，bind 到 target 上避免 this 丢失
 *     —— 这些是工具执行所必需的协议入口，不能静默
 *
 * 设计取舍：用 Proxy 而非新 class —— ACP SDK 的 AgentSideConnection 接口很宽，
 * Proxy 转发能自动覆盖未来新增的协议入口，避免每升一次 SDK 就漏一个。
 */
function wrapConnForSubAgent(
  conn: AgentSideConnection,
  logFile: LogFile,
  progress: ProgressEmitter | undefined,
): AgentSideConnection {
  return new Proxy(conn, {
    get(target, prop, _receiver) {
      if (prop === "sessionUpdate") {
        return async (notif: SessionNotification): Promise<void> => {
          // 全量静默：不向父 UI 发任何 session/update。
          // 关键事件镜像到 subagent 自己的日志文件；噪音事件（per-token chunk
          // / 中间态 tool_call_update / usage_update / plan / available_commands_update）
          // 由 shouldLogNotif 过滤掉，避免把 1500+ 行噪音冲淡 ~80 行真信号
          if (shouldLogNotif(notif)) {
            logFile.write(`${ts()}   ${summarizeNotif(notif)}`);
          }
          // 进度旁路：inner `tool_call` 起始事件向 emitter 报告，由它
          // 用未经 wrap 的 conn 更新父工具卡 content（实时进度行）
          if (progress) {
            const u = notif.update as { sessionUpdate: string } & Record<
              string,
              unknown
            >;
            if (u.sessionUpdate === "tool_call") {
              const title =
                typeof u["title"] === "string" ? u["title"] : "(no title)";
              progress.recordInnerToolCall(title);
            }
          }
          return;
        };
      }
      // 其它方法直接 bind 到原 conn —— 防止 ACP SDK 内部用到 this 时丢失绑定
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v === "function") {
        return (v as (...args: unknown[]) => unknown).bind(target);
      }
      return v;
    },
  }) as AgentSideConnection;
}
