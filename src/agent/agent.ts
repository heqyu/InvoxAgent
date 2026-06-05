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
import { randomUUID } from "node:crypto";
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
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { createLogger } from "../log.js";
const log = createLogger("agent");
import type { LLMProvider } from "../llm/types.js";
import { contentToString } from "../llm/utils.js";
import {
  SessionStore,
  sessionTtlDays,
  syncWithZedThreads,
  titleFromHistory,
  type PersistedSession,
} from "../persistence.js";
import { FileCache } from "../tools/cache.js";
import { listAvailableCommands } from "../tools/skill.js";
import type { PermissionPolicy } from "../tools/types.js";
import {
  loadHooks,
  runSessionStart,
  runUserPromptSubmit,
  runStop,
} from "../plugins/hooks.js";
import { emptyTurnUsage } from "./usage-meter.js";
import { humanizeTokens, contextWindowFor } from "./token-meter.js";
import { agentVersion, maxIterations } from "./agent-helpers.js";
import {
  // system-prompt.ts 中定义的符号；agent.ts 这里 re-export 以保持
  // 外部 API（cli.ts 等）的稳定，避免破坏 import 路径。
  DEFAULT_SYSTEM_PROMPT,
  systemMessageWithMemoryAndSkills,
  THINKING_VALUES,
  buildUserContent,
} from "./system-prompt.js";
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  classifyProviderError,
  serializeRefusalForMeta,
  type ProviderErrorInfo,
} from "./error-mapping.js";
import type {
  AgentConfigOptions,
  AgentModelConfig,
  HookBase,
  Session,
  SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates.js";
import { resolveAgentModel } from "./templates.js";
// 把 session-types 中给 cli.ts 用的 3 个公共类型继续从 agent.ts 导出，
// 避免破坏 `import { type AgentModelConfig } from "./agent/agent.js"` 这条
// 既有路径。Session / HookBase 是内部细节，不再对外暴露。
export type {
  AgentConfigOptions,
  AgentModelConfig,
  SystemPromptDef,
} from "./session-types.js";
export type { AgentTemplate } from "./templates.js";
import { replayHistory } from "./replay-history.js";
import { reportTurnUsage } from "./turn-usage-reporter.js";
import { buildConfigOptions, buildModelState } from "./config-options.js";
import { initMcpForSession, releaseSessionMcp } from "./mcp-lifecycle.js";
import {
  runOneIteration as runIteration,
  type IterationResult,
} from "./prompt-loop.js";

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
  /** syncWithZedThreads 在 agent 生命周期内只跑一次，与 session 数量解耦。 */
  private syncedZed = false;

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
    this.maybeSyncZedThreads(params.cwd);
    const id = randomUUID();

    // configValues 初始值：根据 agents / system_prompt 路径择一填充
    const initialConfigValues: Record<string, string> = { thinking: "off" };
    if (this.configs.agents.length > 0) {
      initialConfigValues["agent"] = this.configs.defaultAgentId!;
    } else {
      initialConfigValues["system_prompt"] = this.configs.defaultSystemPromptId;
    }
    const promptBody = this.effectiveSystemPromptBody(initialConfigValues);

    const session: Session = {
      id,
      cwd: params.cwd,
      history: [systemMessageWithMemoryAndSkills(promptBody, params.cwd)],
      abort: new AbortController(),
      toolState: {
        readPaths: new Set<string>(),
        cache: new FileCache(),
      },
      createdAt: Date.now(),
      configValues: initialConfigValues,
      turnUsage: emptyTurnUsage(),
      turnStartedAt: 0,
      hooks: loadHooks(params.cwd),
    };
    this.sessions.set(id, session);
    log.info("session created", {
      id,
      cwd: params.cwd,
      agent: initialConfigValues["agent"],
      systemPrompt: initialConfigValues["system_prompt"],
    });

    // Phase H：默认 agent 若指定 model（如 Worker 默认 "$MODEL_LITE"），
    // 在 session 一开始就同步到 selectedModel + configValues.model，让用户
    // 第一次发 prompt 就用对模型。env 未设时静默回退到 default model（在
    // applyAgentModel 内 warn）。
    if (this.configs.agents.length > 0) {
      const defaultAgent = this.agentById.get(this.configs.defaultAgentId!);
      if (defaultAgent) this.applyAgentModel(session, defaultAgent);
    }

    // 连接 .claude/.mcp.json 中定义的 MCP servers。
    // 优雅降级：配置缺失或某 server 启动失败，会话仍可继续，只是没 MCP 工具。
    await initMcpForSession(session);

    // 触发 SessionStart hook（不阻塞，best-effort）
    runSessionStart(session.hooks, {
      hook_event_name: "SessionStart",
      ...this.hookBase(session),
      source: "startup",
    }).catch((e) => {
      log.warn(
        "SessionStart hook error",
        e instanceof Error ? e.message : String(e),
      );
    });

    // 把可用 skill 作为 `/` 命令通知 Zed 的 UI。
    //
    // **重要**：必须延后到下一个宏任务发送。ACP SDK 的 Connection.writeQueue
    // 把写出顺序串行化 —— 如果在 processMessage() 调 sendMessage()（响应 session/new）
    // 之前我们就调 sendMessage()（发通知），通知会出现在响应之前。客户端按到达
    // 顺序处理时会因 session 还不存在而静默丢弃通知。setTimeout(fn, 0) 把通知
    // 排到响应（微任务）之后的宏任务，从而保证响应先走。
    setTimeout(() => this.sendAvailableCommands(session).catch(() => {}), 0);

    return {
      sessionId: id,
      models: buildModelState(session, this.models),
      configOptions: buildConfigOptions(session, this.models, this.configs),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.maybeSyncZedThreads(params.cwd);
    const store = new SessionStore(params.cwd);
    const snapshot = store.load(params.sessionId);
    if (!snapshot) {
      throw new Error(
        `session ${params.sessionId} not found on disk under ${store.rootDir()}`,
      );
    }

    log.info("loadSession", {
      sessionId: snapshot.id,
      historyLen: snapshot.history.length,
      cwd: params.cwd,
      selectedModel: snapshot.selectedModel,
      configValues: snapshot.configValues,
    });

    // 恢复 configValues，丢掉本版本不再合法的 key（例如用户上次保存后
    // 把 INVOX_PROMPT_TEMPLATES_FILE 收窄了，或换了 agents 列表）。
    const restoredConfigValues: Record<string, string> = { thinking: "off" };
    if (this.configs.agents.length > 0) {
      restoredConfigValues["agent"] = this.configs.defaultAgentId!;
    } else {
      restoredConfigValues["system_prompt"] =
        this.configs.defaultSystemPromptId;
    }
    if (snapshot.configValues) {
      for (const [k, v] of Object.entries(snapshot.configValues)) {
        if (k === "agent" && this.agentById.has(v)) {
          restoredConfigValues[k] = v;
        } else if (k === "system_prompt" && this.systemPromptById.has(v)) {
          // 仅当本版本走旧路径时才接受 system_prompt 持久值；
          // 否则会让 history[0] 与下拉状态不一致
          if (this.configs.agents.length === 0) restoredConfigValues[k] = v;
        } else if (k === "thinking" && THINKING_VALUES.has(v)) {
          restoredConfigValues[k] = v;
        }
        // 未知 configId 静默丢弃 —— 让旧版本写入的新 key 兼容向前
      }
    }

    const session: Session = {
      id: snapshot.id,
      cwd: params.cwd,
      history: snapshot.history.slice(),
      abort: new AbortController(),
      toolState: {
        readPaths: new Set<string>(),
        cache: new FileCache(),
      },
      store,
      createdAt: snapshot.createdAt,
      // 仅当磁盘上的 selectedModel 仍在当前菜单里才恢复；
      // 用户后来收窄了 INVOX_MODELS 时回退默认，而非沿用不存在的 id。
      selectedModel:
        snapshot.selectedModel &&
        this.availableModelIds.has(snapshot.selectedModel)
          ? snapshot.selectedModel
          : undefined,
      configValues: restoredConfigValues,
      turnUsage: emptyTurnUsage(),
      turnStartedAt: 0,
      lastTurnUsage: snapshot.lastTurnUsage,
      hooks: loadHooks(params.cwd),
    };
    this.sessions.set(session.id, session);

    // 连接 MCP servers（同 newSession）
    await initMcpForSession(session);

    // 用当前 skill 列表 + 当前 agent/system_prompt 选中值刷新 system message
    // —— 持久化的 history[0] 可能是上一次会话留下的旧版本。
    {
      const promptBody = this.effectiveSystemPromptBody(restoredConfigValues);
      session.history[0] = systemMessageWithMemoryAndSkills(
        promptBody,
        session.cwd,
      );
    }

    await replayHistory(session, this.conn);

    // 同 newSession，延后一次宏任务发 available commands
    setTimeout(() => this.sendAvailableCommands(session).catch(() => {}), 0);

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

    return {
      models: buildModelState(session, this.models),
      configOptions: buildConfigOptions(session, this.models, this.configs),
    };
  }

  /**
   * 处理 ACP `session/delete`。客户端（如 Zed）在用户删除一条线程时调用。
   * 我们同步删除磁盘上的 `<cwd>/.invox/sessions/<id>.json`，让两边状态一致。
   */
  async unstable_deleteSession(
    params: DeleteSessionRequest,
  ): Promise<DeleteSessionResponse> {
    // 优先在内存中查找
    const session = this.sessions.get(params.sessionId);
    if (session) {
      // abort 进行中的 prompt + 释放 MCP 池引用。
      // abort 多次调是 no-op，不会抛错。
      try {
        session.abort.abort();
      } catch {
        // already aborted
      }
      await releaseSessionMcp(session);
      const s = new SessionStore(session.cwd);
      s.delete(params.sessionId);
      this.sessions.delete(params.sessionId);
      log.info("deleteSession (in-memory)", {
        sessionId: params.sessionId,
        cwd: session.cwd,
      });
    } else {
      // 不在内存里 —— 我们没法直接知道 cwd，扫一下 store root。
      // 这条路径仅在 agent 在 load 与 delete 之间重启过时进入。
      const scanRoots = [process.cwd()];
      const envOverride = process.env["INVOX_SESSION_DIR"];
      if (envOverride) scanRoots.unshift(envOverride);
      for (const root of scanRoots) {
        const s = new SessionStore(root);
        if (s.delete(params.sessionId)) {
          log.info("deleteSession (disk scan)", {
            sessionId: params.sessionId,
            root: s.rootDir(),
          });
          break;
        }
      }
    }
    return {};
  }

  /**
   * 处理 ACP `session/set_model`。在 SDK 0.23 中改名为 `unstable_setSessionModel`
   * （wire 上的 method 名没变，仅 JS 处理器加 `unstable_` 前缀，因为 spec
   * 仍把该能力放在 `unstable_session_model` 后面）。
   */
  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);
    if (!this.availableModelIds.has(params.modelId)) {
      throw new Error(
        `unknown modelId: ${params.modelId} (available: ${[...this.availableModelIds].join(", ")})`,
      );
    }
    session.selectedModel = params.modelId;
    log.info("setSessionModel", {
      sessionId: session.id,
      modelId: params.modelId,
    });
    // 立即落盘，避免 next prompt() 之前崩溃丢失用户选择
    this.persist(session);
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

    if (params.configId === "model") {
      // 通过 config option 路径再暴露一次 model 切换：当 configOptions 被填充时
      // Zed 的工具栏会用 config_options_view 替代原生 model_selector
      // （二者互斥，见 thread_view.rs:3811）。我们把 model 重新作为
      // 一等 SessionConfigOption(category:"model") 暴露，让用户不丢失换 model 的能力。
      if (!this.availableModelIds.has(value)) {
        throw new Error(
          `unknown model value: ${value} (available: ${[...this.availableModelIds].join(", ")})`,
        );
      }
      session.selectedModel = value;
      // 同步到 configValues，让 configOptionsFor 返回新的 currentValue
      session.configValues.model = value;
    } else if (params.configId === "agent") {
      if (this.configs.agents.length === 0) {
        throw new Error(
          `configId "agent" not enabled (no agent templates loaded)`,
        );
      }
      const agent = this.agentById.get(value);
      if (!agent) {
        throw new Error(
          `unknown agent value: ${value} (available: ${[...this.agentById.keys()].join(", ")})`,
        );
      }
      session.configValues["agent"] = value;
      // 就地替换 history[0]：newSession / loadSession 构造保证该位永远是 system message
      session.history[0] = systemMessageWithMemoryAndSkills(
        agent.prompt,
        session.cwd,
      );
      // Phase H：同步切换 model —— agent.model 解析后写入 session.selectedModel
      this.applyAgentModel(session, agent);
    } else if (params.configId === "system_prompt") {
      if (this.configs.agents.length > 0) {
        throw new Error(
          `configId "system_prompt" disabled when agent templates are active; use "agent" instead`,
        );
      }
      const def = this.systemPromptById.get(value);
      if (!def) {
        throw new Error(
          `unknown system_prompt value: ${value} (available: ${[...this.systemPromptById.keys()].join(", ")})`,
        );
      }
      session.configValues.system_prompt = value;
      // 就地替换 history[0]：newSession / loadSession 构造保证该位永远是 system message
      session.history[0] = systemMessageWithMemoryAndSkills(
        def.prompt,
        session.cwd,
      );
    } else if (params.configId === "thinking") {
      if (!THINKING_VALUES.has(value)) {
        throw new Error(
          `unknown thinking value: ${value} (allowed: ${[...THINKING_VALUES].join(", ")})`,
        );
      }
      session.configValues.thinking = value;
    } else {
      throw new Error(`unknown configId: ${params.configId}`);
    }

    log.info("setSessionConfigOption", {
      sessionId: session.id,
      configId: params.configId,
      value,
    });
    this.persist(session);
    return {
      configOptions: buildConfigOptions(session, this.models, this.configs),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);

    session.abort = new AbortController();
    // 重置本 turn 的 token 计费 —— 不跨 turn 累加，per-turn 数字才对得上"用户刚问的这次"
    session.turnUsage = emptyTurnUsage();
    session.turnStartedAt = Date.now();

    const userContent = buildUserContent(params.prompt);
    log.info("prompt received", {
      sessionId: session.id,
      userText: contentToString(userContent),
      historyLen: session.history.length,
      model: session.selectedModel ?? this.models.defaultModelId,
    });

    // 跑 UserPromptSubmit hook —— 插件可注入额外 context 或彻底拦下 prompt
    const submitResult = await runUserPromptSubmit(session.hooks, {
      hook_event_name: "UserPromptSubmit",
      ...this.hookBase(session),
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
    const hookBase = this.hookBase(session);
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
      this.persist(session);
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

  /**
   * 跑一轮 LLM ↔ tool 往返。实现见 ./prompt-loop.ts —— InvoxAgent 这里
   * 只负责把"实例状态视图"打包成 IterationDeps 注进去。
   */
  private async runOneIteration(session: Session): Promise<IterationResult> {
    return runIteration(session, {
      conn: this.conn,
      provider: this.provider,
      clientCaps: this.clientCaps,
      policy: this.policy,
      defaultModelId: this.models.defaultModelId,
      buildHookBase: (s) => this.hookBase(s),
      // Phase G：把"当前激活的 agent 模板"注入 prompt-loop，
      // 让它按 agent.tools / agent.mcp 过滤暴露给 LLM 的工具集。
      activeAgent: this.activeAgentFor(session),
    });
  }

  /**
   * 当前会话激活的 agent 模板。
   *
   *   - agents 为空 → 返回 undefined（旧 system_prompt 路径）
   *   - configValues.agent 不在最新菜单 → 回退到 defaultAgentId
   */
  private activeAgentFor(session: Session): AgentTemplate | undefined {
    if (this.configs.agents.length === 0) return undefined;
    const id = session.configValues["agent"] ?? this.configs.defaultAgentId!;
    return (
      this.agentById.get(id) ?? this.agentById.get(this.configs.defaultAgentId!)
    );
  }

  /**
   * 给定 configValues，计算应注入 history[0] 的 system prompt 主体（不含
   * memory / skills 段——那两段由 systemMessageWithMemoryAndSkills 自动追加）。
   *
   *   - agents 非空 → 取 configValues.agent 对应模板的 prompt
   *   - agents 为空 → 走旧 system_prompt 模板路径
   *
   * 任何路径都保证能取到值；configValues 中的 id 不在表里时回退到默认 id。
   */
  private effectiveSystemPromptBody(
    configValues: Record<string, string>,
  ): string {
    if (this.configs.agents.length > 0) {
      const id = configValues["agent"] ?? this.configs.defaultAgentId!;
      const agent =
        this.agentById.get(id) ??
        this.agentById.get(this.configs.defaultAgentId!)!;
      return agent.prompt;
    }
    const id =
      configValues["system_prompt"] ?? this.configs.defaultSystemPromptId;
    const def =
      this.systemPromptById.get(id) ??
      this.systemPromptById.get(this.configs.defaultSystemPromptId)!;
    return def.prompt;
  }

  /**
   * Phase H：把 agent.model 应用到 session.selectedModel（+ configValues.model）。
   *
   *   - agent.model 未设 → 不动 selectedModel，让用户原本的选择保留
   *   - agent.model = "$MODEL_PRO" / "$MODEL_LITE" / 具体 id → 解析后写入
   *   - 解析后的 id 不在 availableModelIds 里 → 动态加入（让 ACP model 下拉
   *     也能展示新 id；防御性地避免 `unstable_setSessionModel` 路径被拒）
   *   - 解析后与原 selectedModel 相同 → 不更新（避免无效 log 噪音）
   *
   * 永不抛错：env 未设时 resolveAgentModel 内部 warn + 回退 fallback；
   * 这里再判一次"resolved 是否就是 fallback" —— 是则视作"agent 没有覆盖
   * 意图"，保留 selectedModel 现状。
   */
  private applyAgentModel(session: Session, agent: AgentTemplate): void {
    if (!agent.model) return;
    const fallback = session.selectedModel ?? this.models.defaultModelId;
    const resolved = resolveAgentModel(agent.model, fallback);
    if (resolved === fallback) return; // env 未设 / 等于当前 → no-op

    if (!this.availableModelIds.has(resolved)) {
      // 把 PRO/LITE 解析出但不在原 INVOX_MODELS 列表里的 id 动态并入
      this.availableModelIds.add(resolved);
      this.models.available.push({ modelId: resolved, name: resolved });
      log.info("agent model: added resolved id to availableModels", {
        agentId: agent.id,
        modelField: agent.model,
        resolved,
      });
    }

    session.selectedModel = resolved;
    session.configValues["model"] = resolved;
    log.info("agent model: applied", {
      sessionId: session.id,
      agentId: agent.id,
      modelField: agent.model,
      resolved,
    });
  }

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

  /**
   * 在 agent 生命周期内只跑一次 syncWithZedThreads。从 newSession /
   * loadSession（这两个接口才有 cwd）调用。
   */
  private async maybeSyncZedThreads(cwd: string): Promise<void> {
    if (this.syncedZed) return;
    this.syncedZed = true;
    try {
      const store = new SessionStore(cwd);
      await syncWithZedThreads(store.rootDir(), cwd);
    } catch (e) {
      log.warn("maybeSyncZedThreads failed", {
        cwd,
        error: (e as Error).message,
      });
    }
  }

  /**
   * 连接 .claude/.mcp.json 中定义的 MCP servers，把 manager 挂到 session 上。
   * 优雅降级：配置缺失或某 server 启动失败，会话仍可继续，只是没 MCP 工具。
   *
   * 通过 mcp/pool.ts 的共享池获取 manager —— 同 cwd 的多个 session 共用一组
   * MCP 子进程。每次 acquire 必须在 session 销毁路径上对应一次 release（见
   * releaseSessionMcp），否则会泄漏子进程。
   */
  /**
   * MCP 进程池生命周期实现见 ./mcp-lifecycle.ts。
   */

  /**
   * 把当前 skill 目录作为 ACP `available_commands_update` 通知发出去。
   * Zed 把它们渲染为输入框的 `/` 命令菜单。
   *
   * 在 newSession / loadSession 后调一次 —— 这是我们第一次知道 cwd
   * 并能扫 .claude/skills/ 的时机。
   */
  private async sendAvailableCommands(session: Session): Promise<void> {
    const commands = listAvailableCommands(session.cwd);
    if (commands.length === 0) return;
    try {
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: commands,
        },
      });
      log.info("available_commands_update sent", {
        sessionId: session.id,
        cwd: session.cwd,
        count: commands.length,
        names: commands.map((c) => c.name),
      });
    } catch (err) {
      log.warn("sendAvailableCommands failed", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persist(session: Session): void {
    if (!session.store) {
      session.store = new SessionStore(session.cwd);
      session.store.prune(sessionTtlDays());
    }
    const snapshot: PersistedSession = {
      version: 1,
      id: session.id,
      cwd: session.cwd,
      title: titleFromHistory(session.history),
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      history: session.history,
      ...(session.selectedModel
        ? { selectedModel: session.selectedModel }
        : {}),
      ...(Object.keys(session.configValues).length > 0
        ? { configValues: { ...session.configValues } }
        : {}),
      ...(session.lastTurnUsage
        ? { lastTurnUsage: session.lastTurnUsage }
        : {}),
    };
    session.store.save(snapshot);
  }

  /**
   * loadSession 时把磁盘上的 history "重放"给客户端，让 UI 能恢复历史消息和
   * 工具调用卡片。仅做 UI 重建，不重新跑工具。实际实现见 ./replay-history.ts。
   *
   * 单次 LLM 调用的 usage 累加见 ./usage-meter.ts 的 accumulateTurnUsage；
   * turn 结束时的 usage 上报（双通道 + lastTurnUsage 写入）见
   * ./turn-usage-reporter.ts 的 reportTurnUsage。
   *
   * SessionModelState / SessionConfigOption[] 构造见 ./config-options.ts 的
   * buildModelState / buildConfigOptions。
   */
}
