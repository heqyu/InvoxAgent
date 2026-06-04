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
  type ContentBlock,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModelState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { log } from "../log.js";
import type {
  LLMMessage,
  LLMProvider,
  ParsedToolCall,
  UsageInfo,
} from "../llm/types.js";
import { contentToString } from "../llm/utils.js";
import {
  SessionStore,
  sessionTtlDays,
  syncWithZedThreads,
  titleFromHistory,
  type PersistedSession,
} from "../persistence.js";
import { FileCache } from "../tools/cache.js";
import { kindFromTier } from "../tools/permissions.js";
import { listAvailableCommands } from "../tools/skill.js";
import type { McpClientManager } from "../mcp/client.js";
import { acquireMcp, releaseMcp } from "../mcp/pool.js";
import { createMcpTool } from "../mcp/tool.js";
import { getTool, TOOL_SPECS } from "../tools/registry.js";
import { executeTool } from "../tools/router.js";
import type { PermissionPolicy, SessionToolState } from "../tools/types.js";
import {
  loadHooks,
  runSessionStart,
  runUserPromptSubmit,
  runPreToolUse,
  runPostToolUse,
  runPostToolUseFailure,
  runStop,
  type HookRegistry,
} from "../plugins/hooks.js";
import { accumulateTurnUsage, emptyTurnUsage } from "./usage-meter.js";
import { safeParseJSON, parseToolArguments } from "./json.js";
import {
  previewArgs,
  startTitleFor,
  startLocationsFor,
} from "./tool-presentation.js";
import { humanizeTokens, contextWindowFor } from "./token-meter.js";
import { agentVersion, maxIterations } from "./agent-helpers.js";
import {
  // system-prompt.ts 中定义的符号；agent.ts 这里 re-export 以保持
  // 外部 API（cli.ts 等）的稳定，避免破坏 import 路径。
  DEFAULT_SYSTEM_PROMPT,
  systemMessageWithMemoryAndSkills,
  THINKING_VALUES,
  thinkingToReasoningEffort,
  buildUserContent,
} from "./system-prompt.js";
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  classifyProviderError,
  formatProviderErrorForUser,
  serializeRefusalForMeta,
  type ProviderErrorInfo,
} from "./error-mapping.js";

interface Session {
  id: string;
  cwd: string;
  history: LLMMessage[];
  abort: AbortController;
  toolState: SessionToolState;
  store?: SessionStore;
  createdAt: number;
  /**
   * 通过 unstable_setSessionModel 选定的 model id。
   * undefined 时回退到 agent 默认 model（availableModels[0]，源自 INVOX_MODEL）。
   */
  selectedModel?: string;
  /**
   * 按 configId 索引的会话级配置值，驱动 ACP setSessionConfigOption 的下拉项。
   * 值类型恒为 string（当前只产出 select kind）。
   *
   * InvoxAgent 内部管理的保留 key（见 DEFAULT_CONFIG_IDS）：
   *   - "system_prompt" —— 当前 system prompt 模板的 id
   *   - "thinking"      —— "off" | "low" | "medium" | "high"
   *                        （请求时映射到 OpenAI 的 reasoning_effort 字段）
   */
  configValues: Record<string, string>;
  /**
   * 当前 prompt() turn 内累计的 token 计费；进入 prompt() 时重置。
   * turn 末尾通过 agent_thought_chunk + `invox/usage` _meta 扩展上报给客户端。
   */
  turnUsage: {
    input: number;
    output: number;
    total: number;
    calls: number;
    /** 本 turn 内单次调用 prompt_tokens 的最大值 —— 实际 context 占用峰值。
     *  每次调用都 resend 整段 history，故 SUM(prompt_tokens) ≠ context 占用，max 才是。 */
    maxPrompt: number;
    /** 本 turn 内所有调用 cache 命中 tokens 之和。 */
    cached: number;
    /** 与 maxPrompt 来自同一次调用的 cached tokens。 */
    maxCached: number;
  };
  /** prompt() 起始的 wall-clock ms —— 用来算 turn 耗时。 */
  turnStartedAt: number;
  /** MCP client manager —— 持有该会话连接的 MCP servers。 */
  mcpClient?: McpClientManager;
  /**
   * 本会话生效的 hook 注册表。在 newSession / loadSession 时一次性加载并
   * 缓存到 session 上，prompt loop / 各 hook 触发点全部走 `session.hooks`，
   * 不再反复 `loadHooks(cwd)`。底层 hookCache 仍按 cwd 缓存，但显式持有
   * 引用让代码意图更清晰、单测注入更容易。
   */
  hooks: HookRegistry;
  /**
   * 上一次完成的 turn 用量持久化快照，重启后保留，让 reloadSession 后用户
   * 仍能看到上一轮花了多少。
   */
  lastTurnUsage?: {
    input: number;
    output: number;
    total: number;
    calls: number;
    maxPrompt: number;
    maxCached: number;
    cached: number;
    elapsedMs: number;
    model: string;
  };
}

/** 构造 InvoxAgent 时注入的 model 菜单配置。第一项是默认 model。 */
export interface AgentModelConfig {
  /** 对客户端公布的 model 列表，必须非空。 */
  available: ModelInfo[];
  /** 默认 model id，必须在 available 中。会话尚未通过 setSessionModel 选择
   *  model 时使用。 */
  defaultModelId: string;
}

/**
 * 系统提示词菜单中的一行 —— 渲染为 ACP `select` kind 的 SessionConfigOption
 * （id="system_prompt"）。选中某行会替换 Session.history[0] 为 prompt 文本。
 */
export interface SystemPromptDef {
  /** 唯一稳定 id，作为 SessionConfigSelectOption.value。 */
  id: string;
  /** 下拉菜单显示的可读名。 */
  name: string;
  /** 鼠标悬浮提示（可选）。 */
  description?: string;
  /** 真正注入到 history[0] 的 system message 文本。 */
  prompt: string;
}

/**
 * model 选择器之外的全部下拉项配置。
 * 当前包括：system prompt 模板。
 *
 * thinking 选项是硬编码的（off / low / medium / high，对应 OpenAI 的
 * reasoning_effort）—— 取值由上游 API 决定，不开 env 调参。
 */
export interface AgentConfigOptions {
  systemPrompts: SystemPromptDef[];
  /** 必须是 systemPrompts[*].id 之一。 */
  defaultSystemPromptId: string;
}

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
      configs && configs.systemPrompts.length > 0
        ? configs
        : {
            systemPrompts: [
              { id: "default", name: "Default", prompt: DEFAULT_SYSTEM_PROMPT },
            ],
            defaultSystemPromptId: "default",
          };
    this.systemPromptById = new Map(
      this.configs.systemPrompts.map((p) => [p.id, p]),
    );
    if (!this.systemPromptById.has(this.configs.defaultSystemPromptId)) {
      // 同 availableModelIds 的防御性兜底：调用方配置自相矛盾时取首项。
      const first = this.configs.systemPrompts[0]!;
      this.configs.defaultSystemPromptId = first.id;
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
    const defaultPromptId = this.configs.defaultSystemPromptId;
    const session: Session = {
      id,
      cwd: params.cwd,
      history: [
        systemMessageWithMemoryAndSkills(
          this.systemPromptById.get(defaultPromptId)!.prompt,
          params.cwd,
        ),
      ],
      abort: new AbortController(),
      toolState: {
        readPaths: new Set<string>(),
        cache: new FileCache(),
      },
      createdAt: Date.now(),
      configValues: {
        system_prompt: defaultPromptId,
        thinking: "off",
      },
      turnUsage: emptyTurnUsage(),
      turnStartedAt: 0,
      hooks: loadHooks(params.cwd),
    };
    this.sessions.set(id, session);
    log.info("session created", { id, cwd: params.cwd });

    // 连接 .claude/.mcp.json 中定义的 MCP servers。
    // 优雅降级：配置缺失或某 server 启动失败，会话仍可继续，只是没 MCP 工具。
    await this.initMcpForSession(session);

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
      models: this.modelStateFor(session),
      configOptions: this.configOptionsFor(session),
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
    // 把 INVOX_PROMPT_TEMPLATES_FILE 收窄了）。
    const restoredConfigValues: Record<string, string> = {
      system_prompt: this.configs.defaultSystemPromptId,
      thinking: "off",
    };
    if (snapshot.configValues) {
      for (const [k, v] of Object.entries(snapshot.configValues)) {
        if (k === "system_prompt" && this.systemPromptById.has(v)) {
          restoredConfigValues[k] = v;
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
    await this.initMcpForSession(session);

    // 用当前 skill 列表刷新 system prompt —— 持久化的 history[0] 可能是
    // 上一次会话留下的旧版本（或没有）。
    if (restoredConfigValues.system_prompt) {
      const def = this.systemPromptById.get(restoredConfigValues.system_prompt);
      if (def) {
        session.history[0] = systemMessageWithMemoryAndSkills(
          def.prompt,
          session.cwd,
        );
      }
    }

    await this.replayHistory(session);

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
      models: this.modelStateFor(session),
      configOptions: this.configOptionsFor(session),
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
      await this.releaseSessionMcp(session);
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
   *   - `system_prompt` —— 替换 Session.history[0] 为模板的 prompt。已有的
   *     user / assistant 消息保持不动；新 prompt 仅影响后续轮次。
   *
   *   - `thinking` —— 字符串值在 runOneIteration 时映射到 OpenAI 的
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
    } else if (params.configId === "system_prompt") {
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
      configOptions: this.configOptionsFor(session),
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
    let stopReason:
      | "end_turn"
      | "cancelled"
      | "max_turn_requests"
      | "refusal" = "max_turn_requests";
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
        await this.reportTurnUsage(session, stopReason);
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
   * 跑一轮 LLM ↔ tool 往返。返回值：
   *   - { kind: "stop", reason }   —— 终止（end_turn / cancelled / refusal）
   *   - { kind: "continue" }       —— 还要继续（有 tool_calls 已被处理）
   */
  private async runOneIteration(
    session: Session,
  ): Promise<
    | { kind: "stop"; reason: "end_turn" | "cancelled" }
    | { kind: "stop"; reason: "refusal"; error: ProviderErrorInfo }
    | { kind: "continue" }
  > {
    let assistantText = "";
    const toolCalls: ParsedToolCall[] = [];
    let finishReason: "stop" | "tool_calls" | "length" | "other" = "other";

    try {
      // 合并 invox 内置工具与本会话 MCP 工具
      const mcpSpecs = session.mcpClient?.getToolSpecs() ?? [];
      const allTools =
        mcpSpecs.length > 0 ? [...TOOL_SPECS, ...mcpSpecs] : TOOL_SPECS;

      for await (const delta of this.provider.stream({
        messages: session.history,
        signal: session.abort.signal,
        tools: allTools,
        model: session.selectedModel ?? this.models.defaultModelId,
        reasoningEffort: thinkingToReasoningEffort(
          session.configValues.thinking,
        ),
      })) {
        if (session.abort.signal.aborted) break;
        switch (delta.kind) {
          case "text":
            if (delta.text.length > 0) {
              assistantText += delta.text;
              await this.conn.sessionUpdate({
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
            this.accumulateUsage(session, delta.usage);
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
        await this.conn.sessionUpdate({
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

    for (const call of toolCalls) {
      const tool = getTool(call.name);
      const mcpTool =
        !tool && call.name.startsWith("mcp__")
          ? session.mcpClient?.getMcpTool(call.name)
          : undefined;
      const startKind = mcpTool
        ? ("execute" as const)
        : tool
          ? kindFromTier(tool.tier)
          : ("other" as const);
      const startTitle = startTitleFor(call);
      const startLocations = startLocationsFor(call);

      await this.conn.sessionUpdate({
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
      const toolStartedAt = Date.now();

      // 工具参数解析（容错版）：旧实现用裸 JSON.parse(call.arguments)，
      // 一个畸形 JSON 就能挂掉整个 prompt loop。改为：解析失败 → emit failed
      // update + 写一条 error tool message 给 LLM 自我纠错 + continue 下一个 tool_call。
      const argsResult = parseToolArguments(call.arguments);
      if (!argsResult.ok) {
        log.warn("tool args parse failed", {
          name: call.name,
          toolCallId: call.id,
          error: argsResult.error,
        });
        await this.conn.sessionUpdate({
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
        session.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: argsResult.error,
          name: call.name,
        });
        continue;
      }
      const toolArgs: Record<string, unknown> = argsResult.value;

      // PreToolUse hook
      const preResult = await runPreToolUse(session.hooks, {
        hook_event_name: "PreToolUse",
        ...this.hookBase(session),
        tool_name: call.name,
        tool_input: toolArgs,
      });

      if (!preResult.allow) {
        // hook 拒绝了 —— emit denied 状态
        const reason =
          preResult.reason ?? `Tool "${call.name}" blocked by plugin hook.`;
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: "failed",
            title: `${call.name} (blocked by hook)`,
            kind: startKind,
            content: [
              { type: "content", content: { type: "text", text: reason } },
            ],
          },
        });
        session.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: reason,
          name: call.name,
        });
        continue;
      }

      const r = mcpTool
        ? await createMcpTool(mcpTool, session.mcpClient!).execute(toolArgs, {
            conn: this.conn,
            sessionId: session.id,
            cwd: session.cwd,
            caps: this.clientCaps,
            signal: session.abort.signal,
            policy: this.policy,
            toolCallId: call.id,
            state: session.toolState,
          })
        : await executeTool(call.name, JSON.stringify(toolArgs), {
            conn: this.conn,
            sessionId: session.id,
            cwd: session.cwd,
            caps: this.clientCaps,
            signal: session.abort.signal,
            policy: this.policy,
            toolCallId: call.id,
            state: session.toolState,
          });

      log.info("tool end", {
        name: call.name,
        toolCallId: call.id,
        ok: r.ok,
        elapsedMs: Date.now() - toolStartedAt,
        resultBytes: r.resultText.length,
        resultPreview:
          r.resultText.length > 200
            ? r.resultText.slice(0, 200) +
              ` …(+${r.resultText.length - 200} more bytes)`
            : r.resultText,
      });

      // PostToolUse / PostToolUseFailure hook
      if (r.ok) {
        const postResult = await runPostToolUse(session.hooks, {
          hook_event_name: "PostToolUse",
          ...this.hookBase(session),
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
          ...this.hookBase(session),
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

      await this.conn.sessionUpdate({
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

      session.history.push({
        role: "tool",
        tool_call_id: call.id,
        content: r.resultText,
        name: call.name,
      });
    }

    return { kind: "continue" };
  }

  /** 构造每次 hook 通用的 base 字段。 */
  private hookBase(session: Session): {
    session_id: string;
    cwd: string;
    transcript_path?: string;
    model: string;
    client: string;
    version: string;
  } {
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
  private async initMcpForSession(session: Session): Promise<void> {
    try {
      const mcp = await acquireMcp(session.cwd);
      if (mcp) {
        session.mcpClient = mcp;
        log.info("mcp connected for session", {
          sessionId: session.id,
          cwd: session.cwd,
          toolCount: mcp.getToolSpecs().length,
        });
      }
    } catch (e) {
      log.warn("mcp init failed", {
        sessionId: session.id,
        cwd: session.cwd,
        error: (e as Error).message,
      });
      // session 在没有 MCP 工具的情况下继续
    }
  }

  /**
   * 释放 session 持有的 MCP 池引用。所有 session 销毁路径
   * （deleteSession RPC、未来的连接断开路径）都必须经过这里。
   */
  private async releaseSessionMcp(session: Session): Promise<void> {
    if (!session.mcpClient) return;
    session.mcpClient = undefined;
    await releaseMcp(session.cwd).catch((e) => {
      log.warn("mcp pool release error", {
        sessionId: session.id,
        cwd: session.cwd,
        error: (e as Error).message,
      });
    });
  }

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

  /** 构造 session/new、session/load 响应中的 SessionModelState。 */
  private modelStateFor(session: Session): SessionModelState {
    return {
      availableModels: this.models.available,
      currentModelId: session.selectedModel ?? this.models.defaultModelId,
    };
  }

  /**
   * 构造 session/new、session/load 响应中的 SessionConfigOption[] ——
   * 客户端底部工具栏据此渲染额外下拉项（"System Prompt"、"Thinking" 等）。
   *
   * category 选取：system_prompt 落在 `other` 类别（spec 保留的
   * "system_prompt" 类别尚未进入 wire 枚举）；thinking 用 spec 定义的
   * `thought_level` 类别，让客户端能匹配到合适图标。
   */
  private configOptionsFor(session: Session): SessionConfigOption[] {
    const opts: SessionConfigOption[] = [];

    // Model selector ——
    // 当 configOptions 被填充时 Zed 工具栏会切换到 config_options_view
    // （与原生 model_selector 互斥，见 thread_view.rs）。我们把 model 选择
    // 也作为 SessionConfigOption(category:"model") 暴露，让用户不丢失换 model 的能力。
    if (this.models.available.length > 1) {
      opts.push({
        id: "model",
        name: "Model",
        description: "LLM model used for the next turn.",
        category: "model",
        type: "select",
        // 来源 selectedModel，让两条路径（setSessionConfigOption 和
        // unstable_setSessionModel）保持同步
        currentValue: session.selectedModel ?? this.models.defaultModelId,
        options: this.models.available.map((m) => ({
          value: m.modelId,
          name: m.name ?? m.modelId,
        })),
      });
    }

    // System Prompt selector —— 仅当真正有得选时才公布；
    // 单模板场景公布只会徒增 UI 杂乱
    if (this.configs.systemPrompts.length > 1) {
      opts.push({
        id: "system_prompt",
        name: "System Prompt",
        description: "Switch the system prompt template for the next turn.",
        // ACP 的稳定 category 是 mode / model / thought_level；
        // system_prompt 落到自由 string（union 接受 string 用于 forward-compat）
        category: "system_prompt",
        type: "select",
        currentValue:
          session.configValues.system_prompt ??
          this.configs.defaultSystemPromptId,
        options: this.configs.systemPrompts.map((p) => ({
          value: p.id,
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
        })),
      });
    }

    // Thinking / reasoning 强度
    opts.push({
      id: "thinking",
      name: "Thinking",
      description:
        "Reasoning effort sent to the upstream model (OpenAI: reasoning_effort). " +
        "Off disables thinking entirely; higher values cost more tokens but produce better answers on complex tasks.",
      category: "thought_level",
      type: "select",
      currentValue: session.configValues.thinking ?? "off",
      options: [
        { value: "off", name: "Off", description: "No reasoning effort." },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    });

    return opts;
  }

  /**
   * 把单次 provider 上报的 usage 块累加到 session 的 per-turn 总数。
   * 实际累加逻辑放在 ./usage-meter.ts；本方法只是委托，旧调用点保留兼容。
   * 新代码直接调 `accumulateTurnUsage`。
   */
  private accumulateUsage(session: Session, usage: UsageInfo): void {
    accumulateTurnUsage(session.turnUsage, usage);
  }

  /**
   * 上报本 turn 的 token usage。
   *
   * 兼容性双通道：
   *
   * 1. `usage_update` —— ACP 0.13+ `unstable_session_usage` 特性的官方变种。
   *    Zed 在 `acp-beta` 开关开启时把它渲染成 model 下拉旁边的小芯片。
   *    schema：`{ sessionUpdate: "usage_update", used, size, cost? }`。
   *
   * 2. `agent_thought_chunk`（带 `_meta.invox/usage`）—— 兜底渲染。
   *    Zed 把它折叠到 "Thinking" 块里，即便 acp-beta 关着用户也能看到计数。
   *
   * provider 没有 yield usage（如 EchoProvider）时两条都跳过。
   */
  private async reportTurnUsage(
    session: Session,
    stopReason: "end_turn" | "cancelled" | "max_turn_requests" | "refusal",
  ): Promise<void> {
    const u = session.turnUsage;
    if (u.calls === 0) return;
    const model = session.selectedModel ?? this.models.defaultModelId;
    const partial = stopReason !== "end_turn";

    // 1. 官方 usage_update（受 Zed acp-beta 控制）
    const contextWindow = contextWindowFor(model);
    // 用 maxPrompt 作为 context 占用 —— 每次 LLM 调用都 resend 完整 history，
    // SUM(prompt_tokens) 是 billing 维度，不是 context 占用维度。
    const used = u.maxPrompt + u.output;
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "usage_update",
        used,
        size: contextWindow,
      },
    });

    // 2. 算本 turn 耗时
    const elapsedMs =
      session.turnStartedAt > 0 ? Date.now() - session.turnStartedAt : 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    // 3. 兜底通道：agent_thought_chunk + _meta 扩展
    const ctxFmt = humanizeTokens(used);
    const sizeFmt = humanizeTokens(contextWindow);
    // 显示最大 context 那一次的 cache 命中率。maxCached 与 maxPrompt 保证
    // 来自同一调用（accumulateUsage 中对齐），比例有意义。
    // 上限 100% 防 provider bug 上报 cached > prompt。
    const cacheHint =
      u.maxCached > 0 && u.maxPrompt > 0
        ? ` · cache ${Math.round((u.maxCached / u.maxPrompt) * 100)}%`
        : "";
    const text =
      `🪙 Context: ${ctxFmt} / ${sizeFmt}` +
      ` · ${u.calls} turns · ${elapsedSec}s` +
      cacheHint +
      (partial ? ` · ${stopReason}` : "") +
      ` · ${model}`;
    await this.conn.sessionUpdate({
      sessionId: session.id,
      _meta: {
        "invox/usage": {
          turn: {
            input: u.input,
            output: u.output,
            total: u.total,
            calls: u.calls,
            maxPrompt: u.maxPrompt,
            maxCached: u.maxCached,
            cached: u.cached,
          },
          model,
          contextWindow,
          stopReason,
        },
      },
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    });

    // 4. 持久化 lastTurnUsage 供重启后展示
    session.lastTurnUsage = {
      input: u.input,
      output: u.output,
      total: u.total,
      calls: u.calls,
      maxPrompt: u.maxPrompt,
      maxCached: u.maxCached,
      cached: u.cached,
      elapsedMs,
      model,
    };
  }

  /**
   * loadSession 时把磁盘上的 history "重放"给客户端，让 UI 能恢复历史消息和
   * 工具调用卡片。仅做 UI 重建，不重新跑工具。
   */
  private async replayHistory(session: Session): Promise<void> {
    const toolResultById = new Map<string, LLMMessage>();
    for (const m of session.history) {
      if (m.role === "tool" && m.tool_call_id)
        toolResultById.set(m.tool_call_id, m);
    }

    for (const m of session.history) {
      if (m.role === "user") {
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: contentToString(m.content) },
          },
        });
        continue;
      }

      if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content : "";
        if (text.length > 0) {
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
        for (const call of m.tool_calls ?? []) {
          const tool = getTool(call.name);
          const replayLocations = startLocationsFor(call);
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: call.id,
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              status: "in_progress",
              rawInput: safeParseJSON(call.arguments) ?? {
                raw: call.arguments,
              },
              ...(replayLocations ? { locations: replayLocations } : {}),
            },
          });
          const result = toolResultById.get(call.id);
          const resultText = result
            ? typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content)
            : "(no recorded result)";
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: call.id,
              status: "completed",
              title: startTitleFor(call),
              kind: tool ? kindFromTier(tool.tier) : "other",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: resultText },
                },
              ],
              ...(replayLocations ? { locations: replayLocations } : {}),
            },
          });
        }
        continue;
      }
    }
  }
}
