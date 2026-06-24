// SessionLifecycle — 会话生命周期管理。
//
// 从 InvoxAgent 抽出（J2.4a），负责：
//   - createSession（newSession 的业务逻辑）
//   - restoreSession（loadSession 的业务逻辑）
//   - destroy / destroyFromDisk（deleteSession 的清场动作）
//   - persist（落盘）
//   - maybeSyncZedThreads（agent 生命周期内只跑一次）
//   - sendAvailableCommands（ACP available_commands_update 通知）
//
// effectiveSystemPromptBody / applyAgentModel 由 ConfigRouter（J2.4b）提供。

import type {
  AgentSideConnection,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import {
  createLogger,
  formatTimestamp,
  openSessionLogFile,
  setSessionLogFile,
} from "../log.js";
const log = createLogger("agent");
import { createSession as buildSession } from "./session-factory.js";
import {
  SessionStore,
  sessionTtlDays,
  syncWithZedThreads,
  titleFromHistory,
  type PersistedSession,
} from "../persistence.js";
import { listAvailableCommands } from "../tools/skill.js";
import { loadHooks, runSessionStart } from "../plugins/hooks.js";
import { THINKING_VALUES } from "./system-prompt.js";
import {
  configMode,
  type AgentConfigOptions,
  type AgentModelConfig,
  type HookBase,
  type Session,
  type SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";
import { initMcpForSession, releaseSessionMcp } from "./mcp-lifecycle.js";
import { buildConfigOptions } from "./config-options.js";
import type { ConfigRouter } from "./config-router.js";
import type { SystemPromptComposer } from "./system-prompt-composer.js";

/** SessionLifecycle 的依赖注入 bag。 */
export interface SessionLifecycleDeps {
  conn: AgentSideConnection;
  configs: AgentConfigOptions;
  models: AgentModelConfig;
  agentById: ReadonlyMap<string, AgentTemplate>;
  systemPromptById: ReadonlyMap<string, SystemPromptDef>;
  availableModelIds: Set<string>;
  sessions: Map<string, Session>;
  /** 从 InvoxAgent.hookBase 委托。J2.4b 后可能重构。 */
  hookBase: (session: Session) => HookBase;
  /** ConfigRouter 提供 applyAgentModel / activeAgentFor。 */
  router: ConfigRouter;
  /** SystemPromptComposer 提供 history[0] 构造。 */
  composer: SystemPromptComposer;
}

export class SessionLifecycle {
  /** syncWithZedThreads 在 agent 生命周期内只跑一次，与 session 数量解耦。 */
  private syncedZed = false;
  /** 进程生命周期内见过的 cwd，用于 destroyFromDisk 的 disk-scan 路径。 */
  private knownCwds = new Set<string>();

  constructor(private readonly deps: SessionLifecycleDeps) {}

  /**
   * 处理 ACP `session/new` 的核心业务：创建 Session、开启日志、连接 MCP、
   * 触发 SessionStart hook、发送 available_commands 通知。
   *
   * InvoxAgent.newSession 是 1-3 行的 ACP 壳函数，调本方法。
   */
  async createSession(
    cwd: string,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    await this.maybeSyncZedThreads(cwd);
    this.knownCwds.add(cwd);

    // configValues 初始值：根据 agents / system_prompt 路径择一填充
    const initialConfigValues: Record<string, string> = { thinking: "off" };
    if (configMode(this.deps.configs) === "agent") {
      initialConfigValues["agent"] = this.deps.configs.defaultAgentId!;
    } else {
      initialConfigValues["system_prompt"] =
        this.deps.configs.defaultSystemPromptId;
    }
    const session = buildSession({
      cwd,
      history: [], // history[0] 由 composer.refresh 填充
      hooks: loadHooks(cwd),
      configValues: initialConfigValues,
    });
    this.deps.composer.refresh(session);
    this.deps.sessions.set(session.id, session);

    // ── 开启会话独立日志 ────────────────────────────────────────────
    const sessionLog = openSessionLogFile(cwd, session.id, "session");
    session.sessionLog = sessionLog;
    setSessionLogFile(sessionLog);
    const allOpts = buildConfigOptions(
      session,
      this.deps.models,
      this.deps.configs,
    );
    const modelOpt = allOpts.find(
      (o) => o.id === "model" && o.type === "select",
    ) as
      | { id: string; type: "select"; options: Array<{ value: string }> }
      | undefined;
    const modelNames = modelOpt
      ? modelOpt.options.map((o) => o.value).join(", ")
      : "(none)";
    const modelCount = modelOpt ? modelOpt.options.length : 0;
    sessionLog.write(
      `── session start @ ${formatTimestamp(new Date())} ───\n` +
        `  id:     ${session.id}\n` +
        `  cwd:    ${cwd}\n` +
        `  agent:  ${initialConfigValues["agent"] ?? "(none)"}\n` +
        `  model:  ${session.selectedModel ?? this.deps.models.defaultModelId}\n` +
        `  prompt: ${initialConfigValues["system_prompt"] ?? "(none)"}\n` +
        `  models(${modelCount}): ${modelNames}\n`,
    );

    log.info("session created", {
      id: session.id,
      cwd,
      agent: initialConfigValues["agent"],
      systemPrompt: initialConfigValues["system_prompt"],
    });

    // Phase H：默认 agent 若指定 model（如 Worker 默认 "$MODEL_LITE"），
    // 在 session 一开始就同步到 selectedModel + configValues.model，让用户
    // 第一次发 prompt 就用对模型。env 未设时静默回退到 default model（在
    // applyAgentModel 内 warn）。
    if (configMode(this.deps.configs) === "agent") {
      const defaultAgent = this.deps.agentById.get(
        this.deps.configs.defaultAgentId!,
      );
      if (defaultAgent) this.deps.router.applyAgentModel(session, defaultAgent);
    }

    // 连接 .claude/.mcp.json 中定义的 MCP servers。
    // 优雅降级：配置缺失或某 server 启动失败，会话仍可继续，只是没 MCP 工具。
    await initMcpForSession(session);

    // 触发 SessionStart hook（不阻塞，best-effort）
    runSessionStart(session.hooks, {
      hook_event_name: "SessionStart",
      ...this.deps.hookBase(session),
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
      sessionId: session.id,
      configOptions: buildConfigOptions(
        session,
        this.deps.models,
        this.deps.configs,
      ),
    };
  }

  /**
   * 处理 ACP `session/load` 的核心业务：从磁盘恢复 Session、开启日志、
   * 连接 MCP、刷新 system message、发送 available_commands 通知。
   *
   * 调用方（InvoxAgent.loadSession）在拿到 session 后还需调 replayHistory
   * 和渲染 lastTurnUsage —— 这些是 ACP 响应特有的，不属本类职责。
   */
  async restoreSession(
    cwd: string,
    sessionId: string,
  ): Promise<{ session: Session; configOptions: SessionConfigOption[] }> {
    await this.maybeSyncZedThreads(cwd);
    this.knownCwds.add(cwd);
    const store = new SessionStore(cwd);
    const snapshot = store.load(sessionId);
    if (!snapshot) {
      throw new Error(
        `session ${sessionId} not found on disk under ${store.rootDir()}`,
      );
    }

    log.info("loadSession", {
      sessionId: snapshot.id,
      historyLen: snapshot.history.length,
      cwd,
      selectedModel: snapshot.selectedModel,
      configValues: snapshot.configValues,
    });

    // 恢复 configValues，丢掉本版本不再合法的 key（例如用户上次保存后
    // 把 INVOX_PROMPT_TEMPLATES_FILE 收窄了，或换了 agents 列表）。
    const restoredConfigValues: Record<string, string> = { thinking: "off" };
    if (configMode(this.deps.configs) === "agent") {
      restoredConfigValues["agent"] = this.deps.configs.defaultAgentId!;
    } else {
      restoredConfigValues["system_prompt"] =
        this.deps.configs.defaultSystemPromptId;
    }
    if (snapshot.configValues) {
      for (const [k, v] of Object.entries(snapshot.configValues)) {
        if (k === "agent" && this.deps.agentById.has(v)) {
          restoredConfigValues[k] = v;
        } else if (
          k === "system_prompt" &&
          this.deps.systemPromptById.has(v)
        ) {
          // 仅当本版本走旧路径时才接受 system_prompt 持久值；
          // 否则会让 history[0] 与下拉状态不一致
          if (configMode(this.deps.configs) !== "agent")
            restoredConfigValues[k] = v;
        } else if (k === "thinking" && THINKING_VALUES.has(v)) {
          restoredConfigValues[k] = v;
        }
        // 未知 configId 静默丢弃 —— 让旧版本写入的新 key 兼容向前
      }
    }

    // 仅当磁盘上的 selectedModel 仍在当前菜单里才恢复；
    // 用户后来收窄了 providers.json 模型菜单时回退默认，而非沿用不存在的 id。
    const session = buildSession({
      id: snapshot.id,
      cwd,
      history: snapshot.history.slice(),
      hooks: loadHooks(cwd),
      store,
      createdAt: snapshot.createdAt,
      selectedModel:
        snapshot.selectedModel &&
        this.deps.availableModelIds.has(snapshot.selectedModel)
          ? snapshot.selectedModel
          : undefined,
      configValues: restoredConfigValues,
      lastTurnUsage: snapshot.lastTurnUsage,
    });
    this.deps.sessions.set(session.id, session);

    // ── 开启会话独立日志（loadSession 恢复后） ───────────────────────
    const sessionLog = openSessionLogFile(cwd, snapshot.id, "session");
    session.sessionLog = sessionLog;
    setSessionLogFile(sessionLog);
    sessionLog.write(
      `── session load @ ${formatTimestamp(new Date())} ───\n` +
        `  id:          ${snapshot.id}\n` +
        `  cwd:         ${cwd}\n` +
        `  historyLen:  ${snapshot.history.length}\n` +
        `  agent:       ${restoredConfigValues["agent"] ?? "(none)"}\n` +
        `  model:       ${session.selectedModel ?? "(restored)"}\n`,
    );

    // 连接 MCP servers（同 newSession）
    await initMcpForSession(session);

    // 用当前 skill 列表 + 当前 agent/system_prompt 选中值刷新 system message
    // —— 持久化的 history[0] 可能是上一次会话留下的旧版本。
    this.deps.composer.refresh(session);

    // 与 createSession 对称：如果当前 agent mode 已启用，确保 session.selectedModel
    // 反映当前活跃 agent 的 model 字段（PRO/LITE env 解析后的实际值）。这覆盖了
    // 用户上次保存的 selectedModel 已不在 availableModelIds 里的回退情况。
    if (configMode(this.deps.configs) === "agent") {
      const activeAgent = this.deps.router.activeAgentFor(session);
      if (activeAgent) this.deps.router.applyAgentModel(session, activeAgent);
    }

    // 同 newSession，延后一次宏任务发 available commands
    setTimeout(() => this.sendAvailableCommands(session).catch(() => {}), 0);

    return {
      session,
      configOptions: buildConfigOptions(
        session,
        this.deps.models,
        this.deps.configs,
      ),
    };
  }

  /**
   * 处理 ACP `session/delete` 的内存路径：关闭日志 + abort + 释放 MCP +
   * 删除磁盘文件 + 从内存 sessions 移除。
   */
  async destroy(session: Session): Promise<void> {
    // ── 关闭会话日志 ────────────────────────────────────────────
    session.sessionLog?.write(
      `── session end @ ${formatTimestamp(new Date())} ──────\n`,
    );
    session.sessionLog?.close();
    setSessionLogFile(null);
    // ──────────────────────────────────────────────────────────────

    // abort 进行中的 prompt + 释放 MCP 池引用。
    // abort 多次调是 no-op，不会抛错。
    try {
      session.abort.abort();
    } catch {
      // already aborted
    }
    await releaseSessionMcp(session);
    const s = new SessionStore(session.cwd);
    s.delete(session.id);
    this.deps.sessions.delete(session.id);
    log.info("deleteSession (in-memory)", {
      sessionId: session.id,
      cwd: session.cwd,
    });
  }

  /**
   * 不在内存里时的磁盘扫描删除。用于 session 在 load 与 delete 之间
   * agent 重启过的场景。
   */
  destroyFromDisk(sessionId: string): void {
    const scanRoots = [...new Set([process.cwd(), ...this.knownCwds])];
    const envOverride = process.env["INVOX_SESSION_DIR"];
    if (envOverride) scanRoots.unshift(envOverride);
    for (const root of scanRoots) {
      const s = new SessionStore(root);
      if (s.delete(sessionId)) {
        log.info("deleteSession (disk scan)", {
          sessionId,
          root: s.rootDir(),
        });
        break;
      }
    }
  }

  /** 持久化 session 到磁盘。 */
  persist(session: Session): void {
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
   * 在 agent 生命周期内只跑一次 syncWithZedThreads。从 createSession /
   * restoreSession（这两个接口才有 cwd）调用。
   */
  async maybeSyncZedThreads(cwd: string): Promise<void> {
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
   * 把当前 skill 目录作为 ACP `available_commands_update` 通知发出去。
   * Zed 把它们渲染为输入框的 `/` 命令菜单。
   *
   * 在 newSession / loadSession 后调一次 —— 这是我们第一次知道 cwd
   * 并能扫 .claude/skills/ 的时机。
   */
  async sendAvailableCommands(session: Session): Promise<void> {
    const commands = listAvailableCommands(session.cwd);
    if (commands.length === 0) return;
    try {
      await this.deps.conn.sessionUpdate({
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

}
