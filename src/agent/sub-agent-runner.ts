// SubAgent runner —— 启动一个嵌套的 prompt loop，跑一份指定 agent 模板。
//
// 设计契约：
//   - 入口 runSubAgent(deps, opts, signal) 返回 SubAgentRunResult，**永不抛错**：
//     unknown agent / empty prompt / provider 失败 / cancel 全部映射为 result
//   - subagent 共享 parent 的 cwd / mcpClient / hooks / abort —— 用户取消父任务
//     会一并取消 subagent；MCP 子进程引用计数不变（共享池语义）
//   - subagent 拥有独立的 history / toolState / turnUsage / abort：互不污染
//   - **subagent 的 token 消耗不累加进 parent.turnUsage**：父 turnUsage 的语义是
//     "父 turn 单次 LLM 调用的 prompt_tokens 峰值（maxPrompt）"——用于计算
//     "距离 context window 还有多远"。subagent 在自己的独立 history 里跑，
//     不占用父 context，累加会让 token chip 虚高。subagent 的开销在 LLM
//     供应商账单上仍能看到，只是 invox UI 不渲染它。
//   - 经包装的 conn 把 subagent 的 agent_message_chunk 转发为 agent_thought_chunk，
//     UI 上以"思考流"形式展示，避免与父 LLM 文本混在同一段落里
//   - subagent 内部禁止再启动 subagent（递归屏障在 prompt-loop 处实现：
//     inSubAgent=true 时 ToolExecContext.subAgentRunner=undefined）
//
// 不在本文件做的事：
//   - 任何 ACP 协议入口（initialize / newSession 等）—— 这是工具层调用
//   - 持久化 —— subagent 的 history 不写盘，turn 结束就丢
//   - 模板加载 —— 上游已经把 agentRegistry 准备好传进来

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
import { resolveAgentModel, type AgentTemplate } from "./templates.js";
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
  /** 父 session —— 用来取 cwd / mcpClient / hooks / abort，并合并 turnUsage。 */
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

  // 3. 构造 sub-Session
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
    // 共享 session id —— UI 通知（tool_call / agent_thought_chunk）落在父线程内，
    // 不会让 Zed 误以为开了新 thread；hooks 也用同一 session_id。
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

  // 4. 派生 sub IterationDeps：覆盖 conn / activeAgent / inSubAgent
  const wrappedConn = wrapConnForSubAgent(parentDeps.conn);
  const subDeps: IterationDeps = {
    ...parentDeps,
    conn: wrappedConn,
    activeAgent: template,
    inSubAgent: true,
  };

  // 5. 跑 prompt loop
  const max = subAgentMaxIterations();
  let stopReason: SubAgentRunResult["stopReason"] = "max_turn_requests";
  let iterations = 0;
  let runError: string | undefined;
  try {
    for (let i = 0; i < max; i++) {
      iterations += 1;
      if (sub.abort.signal.aborted) {
        stopReason = "cancelled";
        break;
      }
      const result = await runOneIteration(sub, subDeps);
      if (result.kind === "stop") {
        stopReason = result.reason;
        if (result.reason === "refusal") {
          runError = result.error.message;
        }
        break;
      }
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
  } finally {
    parent.abort.signal.removeEventListener("abort", onParentAbort);
    signal.removeEventListener("abort", onParentAbort);
  }

  // 6. 抓取最终输出文本
  //
  // 注意：subagent 的 token 消耗**不**累加进 parent.turnUsage。
  // parent.turnUsage 用于估算"距离父 context window 还有多远"，subagent 跑在
  // 自己独立的 history 里，并不消耗父 context；累加会让 UI token chip 虚高。
  // sub.turnUsage 在函数返回后随 sub Session 一并 GC，仅日志保留 input/output
  // 数字方便排查 LLM 成本。
  const finalText = lastAssistantText(sub.history);

  log.info("subagent done", {
    subagentType: opts.subagentType,
    model: resolvedModel,
    iterations,
    stopReason,
    finalLen: finalText.length,
    subInput: sub.turnUsage.input,
    subOutput: sub.turnUsage.output,
  });

  return {
    ok: stopReason === "end_turn",
    finalText,
    stopReason,
    iterations,
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
 * 给 subagent 用的 conn 包装层。
 *
 * 转发规则：
 *   - agent_message_chunk → 改为 agent_thought_chunk：subagent 的"对话流"以
 *     折叠/灰色的 thought 形式展示，避免与父 LLM 的文字段混在一起
 *   - usage_update：直接吞掉 —— 父 prompt() 会在 turn 末统一上报合并后的 usage，
 *     subagent 单独发一次会让底栏 token chip 闪烁/错乱
 *   - 其它 sessionUpdate（tool_call / tool_call_update / agent_thought_chunk
 *     / available_commands_update / plan / ...）原样转发：用户能看到 subagent
 *     做了哪些工具调用，这是有价值的可观测性
 *   - 非 sessionUpdate 的方法（readTextFile / writeTextFile /
 *     requestPermission / sessionUpdateExt 等）原样转发，bind 到原 conn 上
 *     避免 this 丢失
 *
 * 设计取舍：用 Proxy 而非新 class —— ACP SDK 的 AgentSideConnection 接口很宽，
 * 用 Proxy 转发能自动覆盖未来新增方法，避免每升一次 SDK 就漏一个。
 */
function wrapConnForSubAgent(conn: AgentSideConnection): AgentSideConnection {
  return new Proxy(conn, {
    get(target, prop, _receiver) {
      if (prop === "sessionUpdate") {
        return async (notif: SessionNotification): Promise<void> => {
          const u = notif.update;
          if (u.sessionUpdate === "agent_message_chunk") {
            return target.sessionUpdate({
              sessionId: notif.sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: u.content,
              },
            });
          }
          if (u.sessionUpdate === "usage_update") {
            // 静默吞掉，让父 prompt() 统一上报合并后的 usage
            return;
          }
          return target.sessionUpdate(notif);
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
