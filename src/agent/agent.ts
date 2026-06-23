// InvoxAgent：实现 ACP 的 `Agent` 接口。
//
// 一条 ACP 连接 = 一个 InvoxAgent；一个 agent 持有 N 个 session
// （每次 session/new 一份）。每个 session 有自己的 history、AbortController
// 和 SessionToolState（read-paths 集合 + 文件内容缓存，跨同会话工具调用共享）。
//
// prompt() 主循环：
//   把 user message 追加到 history → 最多 MAX_ITERATIONS 次：
//     stream LLM → emit agent_message_chunk，收集 tool_calls
//     finish 时：
//       无 tool_calls → end_turn
//       有 tool_calls → 逐个 emit tool_call、跑、emit tool_call_update、
//                        把结果追加到 history → 继续
//   超额 → max_turn_requests
//
// MAX_ITERATIONS 默认 50，可通过 INVOX_MAX_ITERATIONS env 覆盖。
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { createLogger } from "../log.js";
const log = createLogger("agent");
import type { LLMProvider } from "../llm/types.js";
import type { PermissionPolicy } from "../tools/types.js";
import { humanizeTokens, contextWindowFor } from "./token-meter.js";
import { agentVersion } from "./agent-helpers.js";
import {
  // system-prompt.ts 中定义的符号；agent.ts 这里 re-export 以保持
  // 外部 API（cli.ts 等）的稳定，避免破坏 import 路径。
  DEFAULT_SYSTEM_PROMPT,
} from "./system-prompt.js";
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";

import type {
  AgentConfigOptions,
  AgentModelConfig,
  HookBase,
  Session,
  SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";
// 把 session-types 中给 cli.ts 用的 3 个公共类型继续从 agent.ts 导出，
// 避免破坏 `import { type AgentModelConfig } from "./agent/agent.js"` 这条
// 既有路径。Session / HookBase 是内部细节，不再对外暴露。
export type {
  AgentConfigOptions,
  AgentModelConfig,
  SystemPromptDef,
} from "./session-types.js";
export type { AgentTemplate, AgentSource } from "./templates/index.js";
import { replayHistory } from "./replay-history.js";
import { buildConfigOptions } from "./config-options.js";
import { ConfigRouter } from "./config-router.js";
import { PromptOrchestrator } from "./prompt-orchestrator.js";
import { SessionLifecycle } from "./session-lifecycle.js";

export class InvoxAgent implements Agent {
  readonly conn: AgentSideConnection;
  private clientCaps: ClientCapabilities = {};
  private clientInfo: Implementation | undefined;
  private sessions = new Map<string, Session>();
  private provider: LLMProvider;
  private policy: PermissionPolicy;
  private models: AgentModelConfig;
  private availableModelIds: Set<string>;
  private configs: AgentConfigOptions;
  private systemPromptById: Map<string, SystemPromptDef>;
  /** agent id → 模板。Phase G：与 systemPromptById 互斥使用。 */
  private agentById: Map<string, AgentTemplate>;
  private router: ConfigRouter;
  private lifecycle: SessionLifecycle;
  private orchestrator: PromptOrchestrator;

  constructor(
    conn: AgentSideConnection,
    provider: LLMProvider,
    policy: PermissionPolicy = "never",
    models?: AgentModelConfig,
    configs?: AgentConfigOptions,
  ) {
    this.conn = conn;
    this.provider = provider;
    this.policy = policy;
    // 调用方（如单元测试）没传 model 配置时给个合理兜底：
    // 用 provider name 合成单条菜单，保证类型不出错。CLI 路径总会传真值。
    this.models =
      models && models.available.length > 0
        ? models
        : {
            available: [{ modelId: provider.name, name: provider.name }],
            defaultModelId: provider.name,
          };
    this.availableModelIds = new Set(
      this.models.available.map((m) => m.modelId),
    );
    if (!this.availableModelIds.has(this.models.defaultModelId)) {
      // 防御性：保证默认 model 一定可达。正常路径 cli.ts 已 unshift 默认值。
      this.availableModelIds.add(this.models.defaultModelId);
    }

    // 配置兜底：原 SYSTEM_PROMPT 作为单条 "default"。CLI 总会传更丰富的配置，
    // 单测可省略。
    this.configs =
      configs && (configs.systemPrompts.length > 0 || configs.agents.length > 0)
        ? configs
        : {
            systemPrompts: [
              { id: "default", name: "Default", prompt: DEFAULT_SYSTEM_PROMPT },
            ],
            defaultSystemPromptId: "default",
            agents: [],
          };
    this.systemPromptById = new Map(
      this.configs.systemPrompts.map((p) => [p.id, p]),
    );
    if (
      this.configs.systemPrompts.length > 0 &&
      !this.systemPromptById.has(this.configs.defaultSystemPromptId)
    ) {
      // 同 availableModelIds 的防御性兜底：调用方配置自相矛盾时取首项。
      const first = this.configs.systemPrompts[0]!;
      this.configs.defaultSystemPromptId = first.id;
    }

    // Phase G：agent 模板索引。agents 为空时走旧 system_prompt 路径，本 map 也为空。
    this.agentById = new Map(this.configs.agents.map((a) => [a.id, a]));
    if (
      this.configs.agents.length > 0 &&
      (!this.configs.defaultAgentId ||
        !this.agentById.has(this.configs.defaultAgentId))
    ) {
      // 防御性兜底：调用方传的 defaultAgentId 与 agents 列表自相矛盾时取首项
      this.configs.defaultAgentId = this.configs.agents[0]!.id;
    }

    this.router = new ConfigRouter(
      this.configs,
      this.models,
      this.agentById,
      this.systemPromptById,
      this.availableModelIds,
    );

    this.lifecycle = new SessionLifecycle({
      conn: this.conn,
      configs: this.configs,
      models: this.models,
      agentById: this.agentById,
      systemPromptById: this.systemPromptById,
      availableModelIds: this.availableModelIds,
      sessions: this.sessions,
      hookBase: (s) => this.hookBase(s),
      router: this.router,
    });

    this.orchestrator = new PromptOrchestrator(
      this.conn,
      this.provider,
      this.policy,
      () => this.clientCaps,
      this.models,
      this.router,
      this.lifecycle,
      (s) => this.hookBase(s),
      this.agentById,
    );
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCaps = params.clientCapabilities ?? {};
    this.clientInfo = params.clientInfo ?? undefined;
    log.info("initialize", {
      provider: this.provider.name,
      clientProtocolVersion: params.protocolVersion,
      clientCaps: this.clientCaps,
      clientInfo: this.clientInfo,
    });

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          delete: {},
        },
        promptCapabilities: {
          image: true, // 现已支持 image_url（OpenAI content-part 数组）
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
      },
      authMethods: [],
    };
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.lifecycle.createSession(params.cwd);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const { session, configOptions } = await this.lifecycle.restoreSession(
      params.cwd,
      params.sessionId,
    );

    await replayHistory(session, this.conn);

    // lastTurnUsage 在 replayHistory **之后**发，让 agent_thought_chunk 渲染
    // 在线程末尾（最后一条消息之后），符合用户预期。
    if (session.lastTurnUsage) {
      const lu = session.lastTurnUsage;
      const used = lu.maxPrompt + lu.output;

      // 1. 工具栏小芯片
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "usage_update",
          used,
          size: contextWindowFor(lu.model),
        },
      });

      // 2. agent_thought_chunk 让 usage 文案出现在线程里
      const ctxFmt = humanizeTokens(used);
      const sizeFmt = humanizeTokens(contextWindowFor(lu.model));
      const elapsedSec = lu.elapsedMs
        ? (lu.elapsedMs / 1000).toFixed(1)
        : "0.0";
      const cacheHint =
        lu.maxCached > 0 && lu.maxPrompt > 0
          ? ` · cache ${Math.round((lu.maxCached / lu.maxPrompt) * 100)}%`
          : "";
      const text =
        `🪙 Context: ${ctxFmt} / ${sizeFmt}` +
        ` · ${lu.calls} turns · ${elapsedSec}s` +
        cacheHint +
        ` · ${lu.model}`;
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      });
    }

    return { configOptions };
  }

  /**
   * 处理 ACP `session/delete`。客户端（如 Zed）在用户删除一条线程时调用。
   * 我们同步删除磁盘上的 `<cwd>/.invox/sessions/<id>.json`，让两边状态一致。
   */
  async unstable_deleteSession(
    params: DeleteSessionRequest,
  ): Promise<DeleteSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      await this.lifecycle.destroy(session);
    } else {
      this.lifecycle.destroyFromDisk(params.sessionId);
    }
    return {};
  }

  /**
   * 处理 ACP `session/set_config_option`，驱动 NewSessionResponse.configOptions
   * 公布的自定义下拉：
   *
   *   - `agent`         —— Phase G：切换 agent 模板。重写 history[0] 为该 agent
   *     的 prompt + memory/skills 段。后续 prompt loop 自动按 agent.tools / mcp
   *     过滤工具集。
   *
   *   - `system_prompt` —— 旧路径（仅 agents 为空时启用）。同上语义但只换 prompt。
   *
   *   - `thinking`      —— 字符串值在 runOneIteration 时映射到 OpenAI 的
   *     reasoning_effort。
   *
   * 按 ACP 规范，响应携带"完整刷新后的 options 列表"——即使只有一项变化也全
   * 量回送，让客户端能整段 re-render 工具栏，无需额外通知。同时立即落盘以
   * 抗 next prompt() 之前的崩溃。
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);

    // 我们只 emit `select` kind，因此 value 必须是 string。
    // 协议的 union 还接受 boolean，这里显式拒绝以保持失败响亮，避免静默强转。
    if (typeof params.value !== "string") {
      throw new Error(
        `configId ${params.configId}: only string-valued (select) options are supported`,
      );
    }
    const value: string = params.value;

    this.router.applyConfigChange(session, params.configId, value);

    log.info("setSessionConfigOption", {
      sessionId: session.id,
      configId: params.configId,
      value,
    });
    this.lifecycle.persist(session);
    return {
      configOptions: buildConfigOptions(session, this.models, this.configs),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);
    return this.orchestrator.run(session, params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    // 设计选择：abort 当前连接下所有活跃 session。ACP cancel 是广播通知，
    // 不带 sessionId，所以我们停掉所有正在跑的 prompt() loop。每个 loop
    // 在 runOneIteration 顶部和 stream 结束后都会检查 signal.aborted，
    // 因此 abort 在一次 iteration 边界内就会扩散下去。
    for (const session of this.sessions.values()) {
      if (!session.abort.signal.aborted) {
        session.abort.abort();
        log.info("cancel: aborted session", { sessionId: session.id });
      }
    }
  }

  // ── 私有方法 ────────────────────────────────────────────────────

  /** 构造每次 hook 通用的 base 字段。返回 HookBase 给 prompt-loop / 各
   *  hook 触发点共用，确保接口统一。 */
  private hookBase(session: Session): HookBase {
    // transcript_path：磁盘上的 session JSON 文件路径。
    // Claude Code 规范："Path to conversation JSON"。仅当 session 至少
    // 持久化过一次时才设。
    let transcriptPath: string | undefined;
    if (session.store) {
      transcriptPath = join(session.store.rootDir(), `${session.id}.json`);
    }

    return {
      session_id: session.id,
      cwd: session.cwd,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      model: session.selectedModel ?? this.models.defaultModelId,
      client: this.clientInfo?.name ?? "",
      version: agentVersion(),
    };
  }

}
