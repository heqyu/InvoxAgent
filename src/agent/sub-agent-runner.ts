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

import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../log.js";
const log = createLogger("sub-agent");
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { LLMMessage } from "../llm/types.js";
import { FileCache } from "../tools/cache.js";
import { runOneIteration, type IterationDeps } from "./prompt-loop.js";
import type { Session } from "./session-types.js";
import { systemMessageWithMemoryAndSkills } from "./system-prompt.js";
import { resolveAgentModel } from "./templates.js";
import { emptyTurnUsage } from "./usage-meter.js";
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
}

export interface SubAgentRunResult {
  ok: boolean;
  finalText: string;
  stopReason: "end_turn" | "max_turn_requests" | "refusal" | "cancelled";
  iterations: number;
  /** 本次运行的独立日志文件绝对路径；写入失败时为 undefined。 */
  logPath?: string;
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

interface SubAgentLogFile {
  path: string;
  write(line: string): void;
  close(): void;
}

/**
 * 给 subagent 用的"封装日志文件"。
 *   - 路径：<cwd>/.invox/logs/subagent-<parent-id-prefix>-<runid>-<ts>.log
 *   - 失败容错：mkdir / openSync 失败时返回 noop log（write/close 都为空），
 *     并 warn 一条主日志；不让日志故障拖崩 subagent 主流程
 *   - **同步写**（openSync / writeSync / closeSync）：subagent 的事件密度不高
 *     （每 turn 几十条），同步写换来"runSubAgent 返回时文件一定可见"的强保证，
 *     单测里能直接 readFileSync 验证；并发 subagent 各自持有独立 fd，不冲突
 *   - 文件名 sanitization：parent session id 取前 8 字符（足够区分），runid
 *     取 UUID 前 8 字符；时间戳用 ISO 但替换冒号/点为短横（Windows 文件名
 *     不允许冒号）
 */
function openSubAgentLog(
  cwd: string,
  parentSessionId: string,
  runId: string,
): SubAgentLogFile {
  const noop: SubAgentLogFile = {
    path: "",
    write: () => {},
    close: () => {},
  };

  const dir = join(cwd, ".invox", "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    log.warn("subagent log: cannot mkdir", {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
    return noop;
  }

  const safeParent = parentSessionId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeRun = runId.slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `subagent-${safeParent}-${safeRun}-${ts}.log`);

  let fd: number;
  try {
    // "a" = append-only；多个 subagent 各自的文件名带 runId/ts，不会互相 append
    fd = openSync(filePath, "a");
  } catch (e) {
    log.warn("subagent log: cannot open fd", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return noop;
  }

  let closed = false;
  return {
    path: filePath,
    write: (line: string) => {
      if (closed) return;
      try {
        writeSync(fd, line.endsWith("\n") ? line : line + "\n");
      } catch {
        // 写失败也不再回报；close() 时仍尝试 closeSync 释放 fd
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // 已经关掉 / 还没打开，都视为 no-op
      }
    },
  };
}

// 时间戳前缀（短而无歧义）—— 与 src/log.ts 对齐成本太高（那边是模块化），
// 这里用 ISO 简化版即可，毕竟单文件单 subagent，分析时按行排序就行
function ts(): string {
  return new Date().toISOString();
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
  const logFile = openSubAgentLog(parent.cwd, parent.id, runId);
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

  const sub: Session = {
    // 共享 parent.id —— hooks / requestPermission 等 ACP 路径需要拿到 sessionId，
    // subagent 复用父的让客户端识别它们属于同一会话。但所有 sessionUpdate 通知
    // 都被 wrapConnForSubAgent 静默掉，UI 不会被打扰。
    id: parent.id,
    cwd: parent.cwd,
    history: [
      systemMessageWithMemoryAndSkills(template.prompt, parent.cwd),
      { role: "user", content: opts.prompt },
    ],
    abort: subAbort,
    // 独立的 toolState —— subagent 的 readPaths / cache 不污染父
    toolState: { readPaths: new Set(), cache: new FileCache() },
    createdAt: Date.now(),
    selectedModel: resolvedModel,
    // thinking 沿用父配置；不暴露 agent / system_prompt / model 等下拉态
    configValues: { thinking: parent.configValues["thinking"] ?? "off" },
    turnUsage: emptyTurnUsage(),
    turnStartedAt: Date.now(),
    // 共享 MCP / hooks —— 同一 cwd 下进程池只有一份
    ...(parent.mcpClient ? { mcpClient: parent.mcpClient } : {}),
    hooks: parent.hooks,
  };

  // 5. 派生 sub IterationDeps：覆盖 conn / activeAgent / inSubAgent
  const wrappedConn = wrapConnForSubAgent(parentDeps.conn, logFile);
  const subDeps: IterationDeps = {
    ...parentDeps,
    conn: wrappedConn,
    activeAgent: template,
    inSubAgent: true,
  };

  // 6. 跑 prompt loop
  const max = subAgentMaxIterations();
  let stopReason: SubAgentRunResult["stopReason"] = "max_turn_requests";
  let iterations = 0;
  let runError: string | undefined;
  try {
    for (let i = 0; i < max; i++) {
      iterations += 1;
      if (sub.abort.signal.aborted) {
        stopReason = "cancelled";
        logFile.write(`${ts()}   iter ${iterations}: cancelled (abort signal)\n`);
        break;
      }
      logFile.write(`${ts()}   iter ${iterations}: start\n`);
      const result = await runOneIteration(sub, subDeps);
      if (result.kind === "stop") {
        stopReason = result.reason;
        if (result.reason === "refusal") {
          runError = result.error.message;
          logFile.write(
            `${ts()}   iter ${iterations}: stop refusal — ${runError}\n`,
          );
        } else {
          logFile.write(`${ts()}   iter ${iterations}: stop ${result.reason}\n`);
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

  return {
    ok: stopReason === "end_turn",
    finalText,
    stopReason,
    iterations,
    ...(logFile.path ? { logPath: logFile.path } : {}),
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
 * 把任意文本截到 max 字符内，溢出加省略号 + 长度提示。日志可读性优先，
 * 超过两行的内容也压成单行（替换换行为 \n 转义）—— 一行一个事件方便 grep。
 */
function preview(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, "\\n");
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + `…(+${oneLine.length - max} chars)`;
}

/**
 * 抽出一条 SessionNotification 的可读摘要，写到 subagent 日志文件。
 *
 * 设计点：
 *   - 每条 update 一行，便于 grep "tool_call" 之类
 *   - 截短长字段（content / title），保留事件结构信息为主
 *   - 不识别的 sessionUpdate kind 直接 JSON 化前 200 字符（forward-compat）
 */
function summarizeNotif(n: SessionNotification): string {
  const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
  const kind = u.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const c = u["content"] as { type?: string; text?: string } | undefined;
      const text = c && typeof c.text === "string" ? c.text : "";
      return `${kind} text="${preview(text, 200)}"`;
    }
    case "tool_call": {
      const id = u["toolCallId"];
      const title = u["title"];
      const status = u["status"];
      const k = u["kind"];
      return `tool_call id=${id} kind=${k} status=${status} title="${preview(String(title ?? ""), 120)}"`;
    }
    case "tool_call_update": {
      const id = u["toolCallId"];
      const status = u["status"];
      const title = u["title"];
      return `tool_call_update id=${id} status=${status} title="${preview(String(title ?? ""), 120)}"`;
    }
    case "usage_update": {
      const used = u["used"];
      const size = u["size"];
      return `usage_update used=${used} size=${size}`;
    }
    default: {
      const j = JSON.stringify(u);
      return `${kind} ${preview(j, 200)}`;
    }
  }
}

/**
 * 给 subagent 用的 conn 包装层。
 *
 * 转发规则：
 *   - 所有 sessionUpdate **完全静默**，不再向父 UI 转发；改为按时间序写到
 *     subagent 自己的日志文件。这样父对话面板上只看到一张"SubAgent"工具卡，
 *     子工具卡（Read/Glob/Edit/...）/ subagent 的对话流 / usage 全部"折叠"
 *     在卡内（视觉上 = 隐藏；实际 = 写到日志）
 *   - 非 sessionUpdate 方法（readTextFile / writeTextFile / requestPermission
 *     / sessionUpdateExt 等）原样转发到原 conn，bind 到 target 上避免 this 丢失
 *     —— 这些是工具执行所必需的协议入口，不能静默
 *
 * 设计取舍：用 Proxy 而非新 class —— ACP SDK 的 AgentSideConnection 接口很宽，
 * Proxy 转发能自动覆盖未来新增的协议入口，避免每升一次 SDK 就漏一个。
 */
function wrapConnForSubAgent(
  conn: AgentSideConnection,
  logFile: SubAgentLogFile,
): AgentSideConnection {
  return new Proxy(conn, {
    get(target, prop, _receiver) {
      if (prop === "sessionUpdate") {
        return async (notif: SessionNotification): Promise<void> => {
          // 全量静默：不向父 UI 发任何 session/update。改为镜像到 subagent
          // 自己的日志文件。
          logFile.write(`${ts()}   ${summarizeNotif(notif)}`);
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
