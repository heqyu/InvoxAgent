// PromptOrchestrator — prompt() 主循环的独立 collaborator。
//
// 从 InvoxAgent 抽出（J2.4c），负责：
//   - turn 初始化（abort / turnUsage 重置）
//   - UserPromptSubmit hook
//   - iter 循环（LLM ↔ tool 往返）
//   - Stop hook 重入逻辑
//   - 顶层 try/catch → refusal 兜底
//   - finally → reportTurnUsage + persist + 日志收尾
//   - PromptResponse 构造
//
// InvoxAgent.prompt() 是 1-3 行的 ACP 壳函数，查 session 后委托本类。

import type {
  AgentSideConnection,
  ClientCapabilities,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { createLogger, formatTimestamp, preview } from "../log.js";
const log = createLogger("agent");
import type { LLMProvider } from "../llm/types.js";
import { contentToString } from "../llm/utils.js";
import {
  runUserPromptSubmit,
  runStop,
} from "../plugins/hooks.js";
import { emptyTurnUsage } from "./usage-meter.js";
import { maxIterations } from "./agent-helpers.js";
import { buildUserContent } from "./system-prompt.js";
import {
  classifyProviderError,
  serializeRefusalForMeta,
  type ProviderErrorInfo,
} from "./error-mapping.js";
import type {
  AgentModelConfig,
  HookBase,
  Session,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";
import { reportTurnUsage } from "./turn-usage-reporter.js";
import type { ConfigRouter } from "./config-router.js";
import type { SessionLifecycle } from "./session-lifecycle.js";
import type { PermissionPolicy } from "../tools/types.js";
import {
  runOneIteration as runIteration,
  type IterationResult,
} from "./prompt-loop.js";

export class PromptOrchestrator {
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly provider: LLMProvider,
    private readonly policy: PermissionPolicy,
    private readonly getClientCaps: () => ClientCapabilities,
    private readonly models: AgentModelConfig,
    private readonly router: ConfigRouter,
    private readonly lifecycle: SessionLifecycle,
    private readonly hookBaseFactory: (s: Session) => HookBase,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
  ) {}

  /**
   * 执行一次完整的 prompt turn：初始化 → UserPromptSubmit hook →
   * iter 循环 → Stop hook → reportTurnUsage → persist → 返回 PromptResponse。
   */
  async run(
    session: Session,
    params: PromptRequest,
  ): Promise<PromptResponse> {
    session.abort = new AbortController();
    // 重置本 turn 的 token 计费 —— 不跨 turn 累加，per-turn 数字才对得上"用户刚问的这次"
    session.turnUsage = emptyTurnUsage();
    session.turnStartedAt = Date.now();

    const userContent = buildUserContent(params.prompt);
    const userText = contentToString(userContent);
    log.info("prompt received", {
      sessionId: session.id,
      userText,
      historyLen: session.history.length,
      model: session.selectedModel ?? this.models.defaultModelId,
    });
    session.sessionLog?.write(
      `── turn start @ ${formatTimestamp(new Date())} ────\n` +
        `  user:   ${preview(userText, 200)}\n` +
        `  model:  ${session.selectedModel ?? this.models.defaultModelId}\n` +
        `  hist:   ${session.history.length} msgs\n`,
    );

    // 跑 UserPromptSubmit hook —— 插件可注入额外 context 或彻底拦下 prompt
    const submitResult = await runUserPromptSubmit(session.hooks, {
      hook_event_name: "UserPromptSubmit",
      ...this.hookBaseFactory(session),
      prompt: contentToString(userContent),
    });

    if (!submitResult.continue) {
      log.info("prompt blocked by hook", { sessionId: session.id });
      return { stopReason: "end_turn" };
    }

    // 把 hook 提供的 systemMessage 仅本轮合并进 system prompt（不持久化）
    if (submitResult.systemMessage) {
      const sys = session.history[0];
      const prefix =
        typeof sys?.content === "string"
          ? sys.content
          : JSON.stringify(sys?.content);
      session.history[0] = {
        role: "system",
        content: prefix + "\n\n" + submitResult.systemMessage,
      };
    }

    session.history.push({
      role: "user",
      content: userContent,
    });

    const max = maxIterations();
    let stopReason: "end_turn" | "cancelled" | "max_turn_requests" | "refusal" =
      "max_turn_requests";
    /**
     * refusal 时携带 ProviderErrorInfo，最终落到 PromptResponse 的
     * _meta["invox/error"]。给 ACP 客户端一个可机读的错误根因，同时不破坏
     * 向后兼容（_meta 是协议官方扩展点）。
     */
    let refusalInfo: ProviderErrorInfo | undefined;
    const hookBase = this.hookBaseFactory(session);
    // 与 Claude Code 一致：只有当 Stop hook 真正阻塞过、loop 继续了，下一次
    // Stop hook 调用才置 true；hook 放行或首次调用都为 false。
    let stopHookActive = false;
    try {
      for (let iter = 0; iter < max; iter++) {
        const result = await this.runOneIteration(session);
        if (result.kind === "stop") {
          // refusal：直接收尾，不跑 Stop hook（错误流已经发出，再跑 hook
          // 容易掩盖根因）
          if (result.reason === "refusal") {
            stopHookActive = false;
            stopReason = "refusal";
            refusalInfo = result.error;
            break;
          }
          // 仅 end_turn 触发 Stop hook —— cancelled 和 max_iterations 直接跳过
          // （与 Claude Code 一致：只有模型自然停下时才跑）
          if (result.reason === "end_turn") {
            const stopResult = await runStop(session.hooks, {
              hook_event_name: "Stop",
              ...hookBase,
              stop_hook_active: stopHookActive,
            }).catch((e) => {
              log.warn(
                "Stop hook error",
                e instanceof Error ? e.message : String(e),
              );
              return { continue: true } as {
                continue: boolean;
                systemMessage?: string;
              };
            });

            if (!stopResult.continue && stopResult.systemMessage) {
              log.info("Stop hook blocked, continuing loop", {
                sessionId: session.id,
                stopHookActive,
              });
              session.history.push({
                role: "user",
                content: `[Stop hook] ${stopResult.systemMessage}`,
              });
              stopHookActive = true;
              continue;
            }
          }

          stopHookActive = false;
          stopReason = result.reason;
          break;
        }
        if (session.abort.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
      }
      if (stopReason === "max_turn_requests") {
        log.warn("prompt: hit max iterations", { sessionId: session.id, max });
      }
    } catch (err) {
      // 兜底 catch：prompt() 必须始终返回合法 PromptResponse。
      // runOneIteration 之外的意外（hook 同步异常、stream 写失败等）都
      // 映射成 refusal，避免裸 RPC 错误漏出去。
      const classified = classifyProviderError(err);
      stopReason = classified.kind === "abort" ? "cancelled" : "refusal";
      if (classified.kind === "refusal") {
        refusalInfo = classified.info;
      }
      log.error("prompt: unexpected error caught at top level", {
        sessionId: session.id,
        stopReason,
        message:
          classified.kind === "refusal"
            ? classified.info.message
            : "abort signaled at top level",
      });
    } finally {
      // 任何收尾路径（含 cancel / max iterations）都尽力上报一次 usage，
      // 让用户看到 partial turn 花了多少。best-effort：上报失败不应掩盖 stopReason。
      try {
        await reportTurnUsage(
          session,
          stopReason,
          this.conn,
          this.models.defaultModelId,
        );
      } catch (err) {
        log.warn(
          "prompt: usage report failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      // ── turn 收尾写日志 ──────────────────────────────────────────
      const elapsedMs = Date.now() - session.turnStartedAt;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const tu = session.turnUsage;
      session.sessionLog?.write(
        `── turn end @ ${formatTimestamp(new Date())} ──────\n` +
          `  stop=${stopReason}  iter=${tu.calls}  ` +
          `elapsed=${elapsedSec}s  in=${tu.input}  out=${tu.output}\n`,
      );
      if (refusalInfo && session.sessionLog) {
        session.sessionLog.write(
          `  error: ${preview(refusalInfo.message, 500)}\n`,
        );
      }

      this.lifecycle.persist(session);
    }
    // 构造带可选 usage 字段的 PromptResponse。在 SDK 0.23 中 usage 是 PromptResponse
    // 的强类型字段（旧的 @zed-industries 包还需要 cast）。Zed 的 acp_thread.rs:2504
    // 把这些 token 拉进 thread.token_usage（受 AcpBetaFeatureFlag 控制），
    // 与 SessionUpdate::UsageUpdate 路径冗余 —— 两条都发能最大化点亮底栏 token chip 的概率。
    //
    // refusal 时往 _meta["invox/error"] 塞 ProviderErrorInfo —— ACP 协议把
    // _meta 列为扩展点（types.gen.d.ts:3856-3866），客户端识别就能机读，
    // 不识别也不破坏 stopReason 的标准语义。
    const u = session.turnUsage;
    const meta = refusalInfo
      ? { "invox/error": serializeRefusalForMeta(refusalInfo) }
      : undefined;
    const response: PromptResponse =
      u.calls > 0
        ? {
            stopReason,
            usage: {
              totalTokens: u.total,
              inputTokens: u.input,
              outputTokens: u.output,
            },
            ...(meta ? { _meta: meta } : {}),
          }
        : { stopReason, ...(meta ? { _meta: meta } : {}) };
    return response;
  }

  /**
   * 跑一轮 LLM ↔ tool 往返。实现见 ./prompt-loop.ts —— PromptOrchestrator 这里
   * 只负责把"实例状态视图"打包成 IterationDeps 注进去。
   */
  private async runOneIteration(session: Session): Promise<IterationResult> {
    return runIteration(session, {
      conn: this.conn,
      provider: this.provider,
      clientCaps: this.getClientCaps(),
      policy: this.policy,
      defaultModelId: this.models.defaultModelId,
      buildHookBase: (s) => this.hookBaseFactory(s),
      // Phase G：把"当前激活的 agent 模板"注入 prompt-loop，
      // 让它按 agent.tools / agent.mcp 过滤暴露给 LLM 的工具集。
      activeAgent: this.router.activeAgentFor(session),
      // SubAgent 工具据此查 subagent_type → 模板。空 map 时 SubAgent
      // 工具会拒绝启动并返回友好错误（agents 路径未启用的旧用户场景）。
      agentRegistry: this.agentById,
    });
  }
}


