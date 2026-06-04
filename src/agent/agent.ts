// InvoxAgent: implements the ACP `Agent` interface.
//
// One ACP connection = one InvoxAgent. One agent owns N sessions
// (one per session/new request). Each session has its own history,
// its own AbortController for cancellation, and its own SessionToolState
// (read-paths set + file content cache) shared across the session's
// tool calls.
//
// prompt() loop:
//   append user msg → up to MAX_ITERATIONS:
//     stream LLM → emit agent_message_chunks, collect tool_calls
//     on finish:
//       no tool_calls   → end_turn
//       has tool_calls  → for each: emit tool_call, run, emit tool_call_update,
//                          append tool result → continue
//   exceeded → max_turn_requests
//
// MAX_ITERATIONS defaults to 50; override via INVOX_MAX_ITERATIONS env.
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
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
  UserContent,
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
import { loadClaudeMd } from "../discovery/claude-md.js";
import { McpClientManager } from "../mcp/client.js";
import { loadMcpConfig } from "../mcp/config.js";
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
import { accumulateTurnUsage } from "./usage-meter.js";
import { safeParseJSON, parseToolArguments } from "./json.js";

/** Read the agent package version once, cache for the process lifetime. */
let _agentVersion: string | undefined;
function agentVersion(): string {
  if (!_agentVersion) {
    try {
      const p = join(__dirname, "..", "package.json");
      _agentVersion = (
        JSON.parse(readFileSync(p, "utf8")) as { version: string }
      ).version;
    } catch {
      _agentVersion = "unknown";
    }
  }
  return _agentVersion;
}

function maxIterations(): number {
  const raw = process.env["INVOX_MAX_ITERATIONS"];
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}

interface Session {
  id: string;
  cwd: string;
  history: LLMMessage[];
  abort: AbortController;
  toolState: SessionToolState;
  store?: SessionStore;
  createdAt: number;
  /**
   * Model id picked via `unstable_setSessionModel`. Undefined → fall back
   * to the agent's default model (the first entry of `availableModels`,
   * which is itself derived from `INVOX_MODEL`).
   */
  selectedModel?: string;
  /**
   * Per-session configuration option values, keyed by configId. Drives
   * the dropdowns surfaced via ACP `setSessionConfigOption`. Values are
   * always strings (we only emit `select` kinds for now).
   *
   * Reserved keys (managed by InvoxAgent, see DEFAULT_CONFIG_IDS):
   *   - "system_prompt" — id of the active system prompt template
   *   - "thinking"      — "off" | "low" | "medium" | "high" (mapped to
   *                        OpenAI's reasoning_effort field at request time)
   */
  configValues: Record<string, string>;
  /**
   * Token accounting accumulated across all LLM calls within the current
   * `prompt()` turn. Reset at the top of every prompt() call. Surfaced to
   * the client right before the turn ends as an `agent_thought_chunk`
   * with an `invox/usage` _meta extension.
   */
  turnUsage: {
    input: number;
    output: number;
    total: number;
    calls: number;
    /** Largest prompt_tokens seen in any single LLM call this turn —
     *  represents the actual context-window footprint (each call re-sends
     *  the full history, so the sum of prompt_tokens across calls is NOT
     *  the context usage). */
    maxPrompt: number;
    /** Tokens served from prompt cache across all calls this turn. */
    cached: number;
    /** Cache tokens from the call that produced maxPrompt (aligned pair). */
    maxCached: number;
  };
  /** Wall-clock ms when prompt() started — used to compute turn elapsed. */
  turnStartedAt: number;
  /** MCP client manager — owns connected MCP servers for this session. */
  mcpClient?: McpClientManager;
  /**
   * 本会话生效的 hook 注册表（A4 / K6）—— 在 newSession / loadSession 时一次
   * 加载并缓存到 session 上，prompt loop / 各 hook 触发点全部走 `session.hooks`
   * 不再反复 `loadHooks(cwd)`。底层 `hookCache` 仍然按 cwd 缓存，但显式持有
   * 引用让代码意图更清晰、单测注入更容易。
   */
  hooks: HookRegistry;
  /**
   * Persisted snapshot of the last completed turn's usage. Survives restarts
   * so the user can see what the previous turn cost after reloadSession.
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

/** Configuration injected at construction time describing the model menu the
 *  user can choose from in their client. The first entry is the default. */
export interface AgentModelConfig {
  /** Models advertised to the client. MUST be non-empty. */
  available: ModelInfo[];
  /** Default model id; must appear in `available`. Used when a session has
   *  not yet pinned a model via `setSessionModel`. */
  defaultModelId: string;
}

/**
 * One row in the system-prompt menu rendered as an ACP `select`-kind
 * `SessionConfigOption` (id="system_prompt"). Picking a row replaces
 * `Session.history[0]` with `prompt`.
 */
export interface SystemPromptDef {
  /** Unique stable id; used as the SessionConfigSelectOption.value. */
  id: string;
  /** Human-readable label rendered in the dropdown. */
  name: string;
  /** Optional description shown as hover text by the client. */
  description?: string;
  /** The actual text injected as the `system` message at history[0]. */
  prompt: string;
}

/**
 * Bundles every dropdown invox advertises beyond the model selector.
 * Currently: system-prompt template + thinking/reasoning level.
 *
 * The thinking option is hard-coded (off/low/medium/high mapping to
 * OpenAI's `reasoning_effort`) — there's no env knob because the values
 * are fixed by the upstream API surface.
 */
export interface AgentConfigOptions {
  systemPrompts: SystemPromptDef[];
  /** Must be one of `systemPrompts[*].id`. */
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
  /** Tracks whether syncWithZedThreads has already run for this agent
   *  lifetime. We want it to fire exactly once, not per-session. */
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
    // Sensible fallback when callers (e.g. unit tests) don't pass a config:
    // synthesize a single-entry menu from the provider name so types stay
    // coherent. CLI always passes a real config.
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
      // Defensive: ensure default is reachable. Not expected to fire in
      // normal use because cli.ts unshifts the default.
      this.availableModelIds.add(this.models.defaultModelId);
    }

    // configs default: the original SYSTEM_PROMPT as a single "default" row.
    // CLI always passes a richer config, but unit tests can omit.
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
      // Same defensive fallback as availableModelIds: surface a sane default
      // if the caller's config disagrees with itself.
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
          image: true, // now we support image_url via OpenAI content-part array
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
      turnUsage: emptyUsage(),
      turnStartedAt: 0,
      hooks: loadHooks(params.cwd),
    };
    this.sessions.set(id, session);
    log.info("session created", { id, cwd: params.cwd });

    // Connect to MCP servers defined in .claude/.mcp.json.
    // Graceful degradation: if config is missing or any server fails,
    // the session continues without MCP tools.
    await this.initMcpForSession(session);

    // Fire SessionStart hooks (non-blocking, best-effort).
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

    // Advertise available skills as `/` commands in Zed's UI.
    //
    // IMPORTANT: Must be deferred to the next macrotask. The ACP SDK's
    // Connection.writeQueue serialises writes — if we call sendMessage()
    // (for the notification) before processMessage() calls sendMessage()
    // (for the session/new response), the notification lands on the wire
    // BEFORE the response. Clients that process messages in arrival order
    // then silently drop the notification because the session doesn't
    // exist yet. Deferring via setTimeout(fn, 0) ensures the response is
    // queued first (microtask), then the notification (macrotask).
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

    // Restore configValues, dropping any keys whose values are no longer
    // valid (e.g. user narrowed INVOX_PROMPT_TEMPLATES_FILE since last save).
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
        // Unknown configIds are silently dropped — forward-compat for old
        // clients that wrote values from a richer build.
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
      // Restore the picked model only if the disk value still appears in our
      // current menu. If the user has since narrowed INVOX_MODELS, fall
      // through to default rather than honor an unavailable id.
      selectedModel:
        snapshot.selectedModel &&
        this.availableModelIds.has(snapshot.selectedModel)
          ? snapshot.selectedModel
          : undefined,
      configValues: restoredConfigValues,
      turnUsage: emptyUsage(),
      turnStartedAt: 0,
      lastTurnUsage: snapshot.lastTurnUsage,
      hooks: loadHooks(params.cwd),
    };
    this.sessions.set(session.id, session);

    // Connect to MCP servers defined in .claude/.mcp.json.
    await this.initMcpForSession(session);

    // Refresh the system prompt with the current skill list — the persisted
    // history[0] may have a stale version (or none) from a previous session.
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

    // Advertise available skills as `/` commands in Zed's UI.
    // Same deferred-send pattern as newSession() — see comment there.
    setTimeout(() => this.sendAvailableCommands(session).catch(() => {}), 0);

    // Send last turn usage AFTER replayHistory so the agent_thought_chunk
    // renders at the bottom of the thread (after the last message), which
    // is where users expect to see it.
    if (session.lastTurnUsage) {
      const lu = session.lastTurnUsage;
      const used = lu.maxPrompt + lu.output;

      // 1. usage_update for the toolbar chip
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "usage_update",
          used,
          size: contextWindowFor(lu.model),
        },
      });

      // 2. agent_thought_chunk so the usage text appears in the thread
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
   * Handle ACP `session/delete`. Called by the client (e.g. Zed) when the
   * user deletes a thread from the session list. We remove the persisted
   * JSON file from `<cwd>/.invox/sessions/<id>.json` so the two sides
   * stay in sync.
   */
  async unstable_deleteSession(
    params: DeleteSessionRequest,
  ): Promise<DeleteSessionResponse> {
    // Try all known sessions first (in-memory).
    const session = this.sessions.get(params.sessionId);
    if (session) {
      // Disconnect MCP servers before cleanup.
      if (session.mcpClient) {
        session.mcpClient.disconnect().catch((e) => {
          log.warn("mcp disconnect error on session delete", {
            sessionId: params.sessionId,
            error: (e as Error).message,
          });
        });
      }
      const s = new SessionStore(session.cwd);
      s.delete(params.sessionId);
      this.sessions.delete(params.sessionId);
      log.info("deleteSession (in-memory)", {
        sessionId: params.sessionId,
        cwd: session.cwd,
      });
    } else {
      // Session not in memory — attempt to delete from disk using the cwd
      // from the session file itself. We don't know cwd at this point, so
      // we scan the store root. This is only reached when the agent was
      // restarted between the load and the delete.
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
   * Handle ACP `session/set_model`. Renamed to `unstable_setSessionModel`
   * in the @agentclientprotocol/sdk@0.23 API (the protocol method name on
   * the wire is unchanged; only the JS handler name carries the
   * `unstable_` prefix because the spec still gates this behind
   * `unstable_session_model`).
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
    // Persist immediately so a crash before the next prompt() doesn't lose
    // the user's choice.
    this.persist(session);
    return {};
  }

  /**
   * Handle ACP `session/set_config_option`. Powers the custom dropdowns
   * advertised via NewSessionResponse.configOptions:
   *
   *   - `system_prompt` — replaces `Session.history[0]` with the chosen
   *     template's prompt. Existing user/assistant messages remain
   *     unchanged; the new prompt only influences turns that haven't
   *     started yet (next user message onward).
   *
   *   - `thinking` — stored as a string; the value is mapped to OpenAI's
   *     `reasoning_effort` field at request time in `runOneIteration`.
   *
   * Per ACP spec the response carries the FULL refreshed list — even if
   * only one option changed — so the client can re-render the whole
   * toolbar without a separate notification. We also persist immediately
   * to survive a crash before the next prompt().
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${params.sessionId}`);

    // We only emit `select`-kind options, so the value MUST be a string.
    // The protocol's union admits `boolean` too, but rejecting it here
    // keeps the failure mode loud rather than silently coercing.
    if (typeof params.value !== "string") {
      throw new Error(
        `configId ${params.configId}: only string-valued (select) options are supported`,
      );
    }
    const value: string = params.value;

    if (params.configId === "model") {
      // Re-expose model switching through the config option path so it
      // works when configOptions replaces the native model_selector in Zed's
      // toolbar (they're mutually exclusive — see thread_view.rs:3811).
      if (!this.availableModelIds.has(value)) {
        throw new Error(
          `unknown model value: ${value} (available: ${[...this.availableModelIds].join(", ")})`,
        );
      }
      session.selectedModel = value;
      // Reflect the change in configValues so configOptionsFor() returns
      // the new currentValue immediately.
      session.configValues.model = value;
    } else if (params.configId === "system_prompt") {
      const def = this.systemPromptById.get(value);
      if (!def) {
        throw new Error(
          `unknown system_prompt value: ${value} (available: ${[...this.systemPromptById.keys()].join(", ")})`,
        );
      }
      session.configValues.system_prompt = value;
      // Replace history[0] in place — by construction of newSession /
      // loadSession that slot is always a system message.
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
    // Reset turn-level token accounting. We deliberately do NOT carry usage
    // across turns — the per-turn box matches what the user just asked for.
    session.turnUsage = emptyUsage();
    session.turnStartedAt = Date.now();

    const userContent = buildUserContent(params.prompt);
    log.info("prompt received", {
      sessionId: session.id,
      userText: contentToString(userContent),
      historyLen: session.history.length,
      model: session.selectedModel ?? this.models.defaultModelId,
    });

    // Run UserPromptSubmit hooks — plugins can inject additional context
    // or block the prompt entirely.
    const submitResult = await runUserPromptSubmit(session.hooks, {
      hook_event_name: "UserPromptSubmit",
      ...this.hookBase(session),
      prompt: contentToString(userContent),
    });

    if (!submitResult.continue) {
      log.info("prompt blocked by hook", { sessionId: session.id });
      return { stopReason: "end_turn" };
    }

    // Merge hook-provided systemMessage into the system prompt
    // for this turn only (not persisted).
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
    let stopReason: "end_turn" | "cancelled" | "max_turn_requests" =
      "max_turn_requests";
    const hookBase = this.hookBase(session);
    // Mirrors Claude Code: true only after a Stop hook actually blocked and the
    // loop continued. Reset to false when the hook放行 or on first call.
    let stopHookActive = false;
    try {
      for (let iter = 0; iter < max; iter++) {
        const result = await this.runOneIteration(session);
        if (result.kind === "stop") {
          // Only fire Stop hook on natural end_turn — cancelled and max_iterations
          // go straight through (matches Claude Code: Stop hook only runs when the
          // model naturally decides to stop).
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
    } finally {
      // Always emit a usage summary (even on cancel / max iterations) so the
      // user sees what the partial turn cost. Best-effort: a failure to send
      // must not hide the underlying stopReason.
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
    // Build a PromptResponse with the optional `usage` field. In
    // @agentclientprotocol/sdk@0.23 this is a typed field on PromptResponse
    // (used to require an `as unknown as` cast under the deprecated
    // @zed-industries package). Zed's acp_thread.rs:2504 pulls these
    // tokens into thread.token_usage when AcpBetaFeatureFlag is on,
    // redundantly with the SessionUpdate::UsageUpdate path. Carrying
    // both maximizes the chance the bottom-bar token chip lights up.
    const u = session.turnUsage;
    const response: PromptResponse =
      u.calls > 0
        ? {
            stopReason,
            usage: {
              totalTokens: u.total,
              inputTokens: u.input,
              outputTokens: u.output,
            },
          }
        : { stopReason };
    return response;
  }

  async cancel(params: CancelNotification): Promise<void> {
    // CHOICE: abort every active session for this connection. The ACP cancel
    // notification doesn't carry a sessionId (it's a broadcast), so we stop
    // all in-flight prompt() loops. Each loop checks signal.aborted at the
    // top of runOneIteration and after the stream, so the abort propagates
    // within one iteration boundary.
    for (const session of this.sessions.values()) {
      if (!session.abort.signal.aborted) {
        session.abort.abort();
        log.info("cancel: aborted session", { sessionId: session.id });
      }
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  /**
   * Build user message content from ACP ContentBlocks.
   *
   * Returns OpenAI-compatible `UserContent` directly:
   *   - text blocks        → { type: "text", text }
   *   - resource_link       → { type: "text", text: "File: <path>" }  (we tell the LLM the path)
   *   - image (with data)  → { type: "image_url", image_url: { url: "data:..." } }
   *   - image (with uri)   → { type: "image_url", image_url: { url: uri } }
   *   - resource (text)    → inlined as text
   *
   * If the result is a single text part, collapse to plain string.
   */
  private async runOneIteration(
    session: Session,
  ): Promise<
    { kind: "stop"; reason: "end_turn" | "cancelled" } | { kind: "continue" }
  > {
    let assistantText = "";
    const toolCalls: ParsedToolCall[] = [];
    let finishReason: "stop" | "tool_calls" | "length" | "other" = "other";

    try {
      // Merge invox built-in tools with MCP tools for this session.
      const mcpSpecs = session.mcpClient?.getToolSpecs() ?? [];
      const allTools =
        mcpSpecs.length > 0 ? [...TOOL_SPECS, ...mcpSpecs] : TOOL_SPECS;

      // ── Log the full assembled context sent to the LLM ──────────
      // System prompt lives at history[0]; tool specs are the complete
      // merged list (built-in + MCP).  Gated behind log.isEnabled("debug")
      // to avoid the cost of stringify when nobody is listening.
      // if (log.isEnabled("debug")) {
      //   const systemMsg = session.history[0];
      //   log.debug("llm request context ▸ system prompt", {
      //     role: systemMsg?.role,
      //     content:
      //       typeof systemMsg?.content === "string"
      //         ? systemMsg.content
      //         : JSON.stringify(systemMsg?.content),
      //     historyLength: session.history.length,
      //   });
      //   log.debug("llm request context ▸ tool specs", {
      //     count: allTools.length,
      //     tools: allTools,
      //   });
      // }

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
      if (isAbort(err)) {
        if (assistantText)
          session.history.push({ role: "assistant", content: assistantText });
        return { kind: "stop", reason: "cancelled" };
      }
      log.error(
        "provider stream failed",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
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

      // ── Tool 参数解析（A3 / K5）──────────────────────────────
      // 旧实现：裸 JSON.parse(call.arguments) —— 一个畸形 JSON 直接挂掉
      // 整个 prompt loop。改为容错版：解析失败 → emit failed update +
      // 写一条 error tool message 给 LLM 自我纠错 + continue 下一个
      // tool_call。
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

      // ── PreToolUse hook ──────────────────────────────────────
      const preResult = await runPreToolUse(session.hooks, {
        hook_event_name: "PreToolUse",
        ...this.hookBase(session),
        tool_name: call.name,
        tool_input: toolArgs,
      });

      if (!preResult.allow) {
        // Hook denied the tool — emit a tool_call_update with denied status.
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
      // ── End PreToolUse hook ──────────────────────────────────

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

      // ── PostToolUse / PostToolUseFailure hooks ────────────────
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
      // ── End PostToolUse hooks ─────────────────────────────────

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

  /** Build the common base fields shared by every hook context. */
  private hookBase(session: Session): {
    session_id: string;
    cwd: string;
    transcript_path?: string;
    model: string;
    client: string;
    version: string;
  } {
    // transcript_path: path to the session JSON file on disk.
    // Claude Code spec: "Path to conversation JSON". Only set if the
    // session has been persisted at least once.
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
   * Run syncWithZedThreads exactly once per agent lifetime.
   * Called from newSession / loadSession — the two entry points that
   * carry a cwd.
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
   * Connect to MCP servers defined in .claude/.mcp.json and attach the
   * manager to the session. Graceful degradation: if the config file is
   * missing or any server fails to start, the session continues without
   * MCP tools.
   */
  private async initMcpForSession(session: Session): Promise<void> {
    try {
      const config = loadMcpConfig(session.cwd);
      if (!config) return;
      const mcp = new McpClientManager();
      await mcp.connect(config.mcpServers);
      if (mcp.getToolSpecs().length > 0) {
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
      // Session continues without MCP tools.
    }
  }

  /**
   * Send the current skill catalog as an ACP `available_commands_update`
   * sessionUpdate. Zed's UI renders these as `/` commands in the input menu.
   *
   * Called once after session creation/load — the first point where we know
   * the session's `cwd` and can scan `.claude/skills/`.
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

  /** Build the SessionModelState handed back on session/new + session/load. */
  private modelStateFor(session: Session): SessionModelState {
    return {
      availableModels: this.models.available,
      currentModelId: session.selectedModel ?? this.models.defaultModelId,
    };
  }

  /**
   * Build the SessionConfigOption[] surfaced on session/new and
   * session/load — these are what the client's bottom toolbar renders as
   * extra dropdowns (e.g. "System Prompt", "Thinking").
   *
   * Categories: `system_prompt` is given as `other` (the spec-reserved
   * "system_prompt" category isn't on the wire enum yet); `thinking`
   * uses the spec-defined `thought_level` category so clients can pick
   * a matching icon.
   */
  private configOptionsFor(session: Session): SessionConfigOption[] {
    const opts: SessionConfigOption[] = [];

    // ── Model selector ────────────────────────────────────────────────────
    // When configOptions is populated, Zed's bottom toolbar switches from
    // the native model_selector to config_options_view (they're mutually
    // exclusive in thread_view.rs). We therefore re-expose model selection
    // as a first-class `SessionConfigOption` with category "model" so the
    // user doesn't lose the ability to switch models.
    if (this.models.available.length > 1) {
      opts.push({
        id: "model",
        name: "Model",
        description: "LLM model used for the next turn.",
        category: "model",
        type: "select",
        // Derive from selectedModel so both paths (setSessionConfigOption
        // and unstable_setSessionModel) stay in sync.
        currentValue: session.selectedModel ?? this.models.defaultModelId,
        options: this.models.available.map((m) => ({
          value: m.modelId,
          name: m.name ?? m.modelId,
        })),
      });
    }

    // ── System Prompt selector ────────────────────────────────────────────
    // Only advertise when there is actually a choice to make; a single-
    // template install would just clutter the UI.
    if (this.configs.systemPrompts.length > 1) {
      opts.push({
        id: "system_prompt",
        name: "System Prompt",
        description: "Switch the system prompt template for the next turn.",
        // ACP's stable categories are `mode` / `model` / `thought_level`;
        // `system_prompt` falls through to free-form (the union admits
        // `string` for forward-compat).
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

    // ── Thinking / reasoning level ────────────────────────────────────────
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

  /** Merge one provider-reported usage block into the session's per-turn
   *  totals. Called from runOneIteration on `usage` deltas.
   *
   *  实际累加逻辑已抽到 `./usage-meter.ts`（Phase A1 / A2 prep），此处仅做委托
   *  以保留旧调用点；新代码请直接调用 `accumulateTurnUsage`。 */
  private accumulateUsage(session: Session, usage: UsageInfo): void {
    accumulateTurnUsage(session.turnUsage, usage);
  }

  /**
   * Send the per-turn token usage report.
   *
   * **Two channels at once** for maximum compatibility:
   *
   * 1. `usage_update` — the official ACP variant from
   *    `agent-client-protocol-schema@0.13`'s `unstable_session_usage`
   *    feature. Zed renders this as a small chip next to the model dropdown
   *    (the UI shown in the user's screenshot) when the `acp-beta`
   *    feature flag is on. Schema:
   *    `{ sessionUpdate: "usage_update", used, size, cost? }`.
   *    The npm package `@zed-industries/agent-client-protocol@0.4.5`
   *    doesn't have this variant in its TS union yet, so we cast through
   *    `unknown` — the wire format is stable JSON and Zed's
   *    `acp_thread.rs` SessionUpdate::UsageUpdate handler picks it up.
   *
   * 2. `agent_thought_chunk` (with `_meta.invox/usage`) — the legacy
   *    fallback. Zed renders this in the collapsed "Thinking" block, so
   *    the user sees the count even with `acp-beta` off.
   *
   * Both are silenced when the provider didn't yield usage at all
   * (e.g. EchoProvider).
   */
  private async reportTurnUsage(
    session: Session,
    stopReason: "end_turn" | "cancelled" | "max_turn_requests",
  ): Promise<void> {
    const u = session.turnUsage;
    if (u.calls === 0) return;
    const model = session.selectedModel ?? this.models.defaultModelId;
    const partial = stopReason !== "end_turn";

    // ── 1. Official usage_update (gated by Zed's acp-beta feature flag) ──
    const contextWindow = contextWindowFor(model);
    // Use maxPrompt as the context footprint — each LLM call re-sends the
    // full history, so the SUM of prompt_tokens across calls (u.input) is a
    // billing metric, not the actual context window occupancy.
    const used = u.maxPrompt + u.output;
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "usage_update",
        used,
        size: contextWindow,
      },
    });

    // ── 2. Compute elapsed time for this turn ──
    const elapsedMs =
      session.turnStartedAt > 0 ? Date.now() - session.turnStartedAt : 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    // ── 3. Visible-today fallback: agent_thought_chunk + _meta extension ──
    const ctxFmt = humanizeTokens(used);
    const sizeFmt = humanizeTokens(contextWindow);
    // Show cache hit ratio for the largest-context call. maxCached and
    // maxPrompt come from the same call (aligned in accumulateUsage), so
    // the ratio is meaningful. Clamp to 100% to guard against provider
    // bugs that report cached > prompt.
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

    // ── 4. Persist lastTurnUsage so it survives restarts ──
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

// ── System message ───────────────────────────────────────────────────

/**
 * The built-in default system prompt — used when no `INVOX_PROMPT_TEMPLATES_FILE`
 * is configured, or as the `default` entry of any custom template list. Kept
 * exported so cli.ts can stitch it into DEFAULT_SYSTEM_PROMPTS.
 */
export const DEFAULT_SYSTEM_PROMPT =
  `You are a helpful coding assistant embedded in Zed (a code editor).\n` +
  `\n` +
  `When the user sends a message you may receive multiple content blocks:\n` +
  `- text: plain user text\n` +
  `- resource_link (file): the user attached a file — use the Read tool to read it before answering\n` +
  `- image: the user attached an image — refer to it in your answer\n` +
  `\n` +
  `Always prefer using tools to answer questions about the codebase. ` +
  `If a file is referenced but not yet read, read it first.\n` +
  `\n` +
  `# Skills\n` +
  `\n` +
  `You have access to a Skill tool that loads reusable workflow templates from .claude/skills/. ` +
  `When the user asks you to use, run, load, or activate a skill — or when their message ` +
  `matches a known skill name — call the Skill tool to load and follow that skill's instructions.\n` +
  `Examples: "use skill /self-constrained-build", "run the review skill", "activate langgpt"\n` +
  `If unsure which skill to use, call Skill({ name: "list" }) to see all available skills.`;

/** Build the OpenAI-shape system message for a given prompt body. */
function systemMessageForPrompt(prompt: string): LLMMessage {
  return { role: "system", content: prompt };
}

/**
 * Build a system message that includes CLAUDE.md memory and available skills.
 *
 * Assembly order:
 *   1. Base system prompt (from template)
 *   2. CLAUDE.md memory sections (user-level, then project-level)
 *   3. Available skill catalog
 *
 * This mirrors Claude Code's behavior where CLAUDE.md is injected into the
 * system prompt as persistent "memory" that guides the LLM's behavior.
 */
function systemMessageWithMemoryAndSkills(
  prompt: string,
  cwd: string,
): LLMMessage {
  let content = prompt;

  // 0. Context: date + platform (helps LLM generate correct shell commands)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const platform = process.platform; // "win32" | "darwin" | "linux"
  const arch = process.arch; // "x64" | "arm64" | ...
  const release = os.release(); // e.g. "10.0.26100"
  content +=
    `\n\n# Context\n\n` +
    `Current date: ${dateStr}\n` +
    `Platform: ${platform} (${arch}), release ${release}\n` +
    `Working directory: ${cwd}`;

  // 1. CLAUDE.md memory (user first, then project)
  const memory = loadClaudeMd(cwd);
  if (memory.length > 0) {
    const sections = memory
      .map((s) => `# CLAUDE.md [${s.source}]\n\n${s.content}`)
      .join("\n\n---\n\n");
    content += `\n\n# Memory\n\nThe following are from the user's CLAUDE.md files. Follow these instructions/preferences:\n\n${sections}`;
  }

  // 2. Available skills
  const commands = listAvailableCommands(cwd);
  if (commands.length > 0) {
    const lines = commands.map((c) => `- ${c.name}: ${c.description}`);
    content +=
      `\n\n# Skills\n\nThe following skills are available for use with the Skill tool:\n\n` +
      lines.join("\n") +
      `\n\nWhen the user types "/<skill-name>", invoke it via Skill. Only use skills listed above, don't guess.`;
  }

  return { role: "system", content };
}

/** Allowed values for the `thinking` config option. Must match the
 *  options advertised in `configOptionsFor`. */
const THINKING_VALUES = new Set(["off", "low", "medium", "high"]);

/**
 * Map the user-facing `thinking` value to the OpenAI SDK's
 * `reasoning_effort` enum. "off" means no reasoning at all (yields
 * undefined so the field is omitted from the request); the rest pass
 * through verbatim.
 */
function thinkingToReasoningEffort(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "none" | undefined {
  if (!value || value === "off") return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

// ── Prompt content builder ──────────────────────────────────────────

/**
 * Convert ACP ContentBlocks into OpenAI-compatible `UserContent`.
 *
 * Strategy:
 *   - Collect all parts into an array of ChatCompletionContentPart.
 *   - If the result is a single plain-text part, collapse to a string
 *     (simpler for logs and for providers that don't support arrays).
 */
function buildUserContent(blocks: ContentBlock[]): UserContent {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;

      case "resource_link": {
        // Tell the LLM which file was attached by name/path.
        // The actual file content is NOT inlined — the LLM should call Read tool.
        const label = block.name ?? block.uri ?? "attached file";
        const path = uriToPath(block.uri);
        parts.push({
          type: "text",
          text: `[File: ${label}]${path ? ` (${path})` : ""}`,
        });
        break;
      }

      case "image": {
        // Inline data URI or pass through the URI.
        const url =
          block.data && block.mimeType
            ? `data:${block.mimeType};base64,${block.data}`
            : (block.uri ?? "");
        if (url) {
          parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }

      case "resource": {
        // Inline text resource directly.
        const txt = "text" in block.resource ? block.resource.text : undefined;
        if (txt) parts.push({ type: "text", text: txt });
        break;
      }

      default:
        // Ignore unknown block types.
        break;
    }
  }

  // Collapse: single text part → plain string
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }

  return parts as OpenAI.Chat.Completions.ChatCompletionContentPart[];
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = uri.slice("file://".length);
  // Windows drive letter: /C:/... → C:/...
  if (p.length > 2 && p[0] === "/" && p[2] === ":") p = p.slice(1);
  // Strip fragment (#L10) and query (?symbol=...)
  const hash = p.indexOf("#");
  if (hash !== -1) p = p.slice(0, hash);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  return p;
}

// ── Helpers ─────────────────────────────────────────────────────────
// safeParseJSON 已抽到 ./json.ts（A3 / K5）；这里仅保留 LLM 输出格式化所需的
// 本地 helper（previewArgs 等）。

function previewArgs(rawArgs: string): unknown {
  const parsed = safeParseJSON(rawArgs);
  if (!parsed) {
    return rawArgs.length > 100 ? rawArgs.slice(0, 100) + "…" : rawArgs;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 100) {
      out[k] = v.slice(0, 100) + `…(+${v.length - 100})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function startTitleFor(call: ParsedToolCall): string {
  const parsed = safeParseJSON(call.arguments);
  // For file-touching tools we deliberately ignore the LLM-supplied
  // `description` and put the path in the title — Zed renders the title
  // next to a "Go to File" affordance, so a translated/paraphrased
  // description would hide the click-target. The description still
  // reaches the user via the tool result body.
  if (parsed) {
    switch (call.name) {
      case "Read": {
        const p = String(parsed["path"] ?? "");
        const offset = parsed["offset"];
        return p
          ? offset
            ? `Read ${p} (lines ${String(offset)}+)`
            : `Read ${p}`
          : "Read file";
      }
      case "Write": {
        const p = String(parsed["path"] ?? "");
        return p ? `Write ${p}` : "Write file";
      }
      case "Edit": {
        const p = String(parsed["path"] ?? "");
        return p ? `Edit ${p}` : "Edit file";
      }
      case "Bash": {
        const c = String(parsed["command"] ?? "");
        return c
          ? `\`${c.slice(0, 80)}${c.length > 80 ? "…" : ""}\``
          : "Run command";
      }
      case "Skill": {
        const n = String(parsed["name"] ?? "");
        return n ? `Skill: ${n}` : "Run skill";
      }
    }
  }
  // Non-file tools fall back to the LLM's free-form description.
  const desc =
    typeof parsed?.["description"] === "string"
      ? parsed["description"].trim()
      : "";
  if (desc) return desc;
  return call.name;
}

/**
 * Build ACP `locations` for the initial tool_call notification, so Zed's
 * "Go to File" / follow-along UI lights up while the tool is still
 * running (not just after completion). Only the file-touching tools
 * have a meaningful path at call-time.
 */
function startLocationsFor(
  call: ParsedToolCall,
): { path: string }[] | undefined {
  const parsed = safeParseJSON(call.arguments);
  if (!parsed) return undefined;
  if (call.name === "Read" || call.name === "Write" || call.name === "Edit") {
    const p = typeof parsed["path"] === "string" ? parsed["path"].trim() : "";
    if (p) return [{ path: p }];
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  )
    return true;
  if (err instanceof Error && /aborted/i.test(err.message)) return true;
  return false;
}

/** Fresh per-turn token accumulator. */
function emptyUsage(): {
  input: number;
  output: number;
  total: number;
  calls: number;
  maxPrompt: number;
  maxCached: number;
  cached: number;
} {
  return {
    input: 0,
    output: 0,
    total: 0,
    calls: 0,
    maxPrompt: 0,
    maxCached: 0,
    cached: 0,
  };
}

/**
 * Render an integer token count the way Zed does in its token-meter tooltip:
 * "1234" → "1.2k", "1234567" → "1.2M". Shorter than the raw number, easier
 * to scan inside a single-line thought chunk.
 */
function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Best-effort context-window lookup for a model id. Used as the `size` field
 * on the ACP `usage_update` notification (matches the rendering
 * `Input: <used> / <size>` in clients like Zed).
 *
 * Resolution order:
 *   1. `INVOX_CONTEXT_WINDOW_<MODELID>` env (uppercased, dots/dashes/slashes
 *      → underscores). Lets users override per model — e.g. for
 *      `qwen/qwen3-coder-30b` set `INVOX_CONTEXT_WINDOW_QWEN_QWEN3_CODER_30B=131072`.
 *   2. `INVOX_CONTEXT_WINDOW_DEFAULT` env — fallback for unknown ids.
 *   3. A small built-in table for popular families (gpt-4o, deepseek, qwen, …).
 *   4. Final fallback: 128_000 (~ what most current frontier models offer;
 *      better than 0 which would make Zed render "0/0").
 *
 * Returns a u64-safe integer.
 */
function contextWindowFor(modelId: string): number {
  // 1. Per-model env override
  const envKey = `INVOX_CONTEXT_WINDOW_${modelId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    const n = Number.parseInt(envOverride, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 2. Global default override
  const defaultEnv = process.env["INVOX_CONTEXT_WINDOW_DEFAULT"];
  if (defaultEnv) {
    const n = Number.parseInt(defaultEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 3. Built-in heuristics. Order matters — first match wins.
  const id = modelId.toLowerCase();
  for (const [pattern, size] of CONTEXT_WINDOW_TABLE) {
    if (id.includes(pattern)) return size;
  }
  // 4. Final fallback. 128k is a safe modern default that won't make Zed
  // render a meaningless `used / 0` ratio.
  return 128_000;
}

/**
 * Substring → context-window pairs. We match by substring rather than exact
 * id so user-supplied display names (e.g. "qwen/qwen3-coder-30b") still
 * resolve. Sizes are vendor-published max context for the family.
 */
const CONTEXT_WINDOW_TABLE: ReadonlyArray<readonly [string, number]> = [
  // OpenAI
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_385],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  // Anthropic (via OAI-compat proxies)
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-opus-4", 200_000],
  ["claude", 200_000],
  // Open weights — common deployments
  ["deepseek-r1", 128_000],
  ["deepseek-v3", 128_000],
  ["deepseek-coder", 128_000],
  ["deepseek", 128_000],
  ["qwen3-coder", 256_000],
  ["qwen3", 128_000],
  ["qwen2.5", 128_000],
  ["qwen", 128_000],
  ["llama-3.3", 128_000],
  ["llama-3.1", 128_000],
  ["llama", 8_192],
  // Xiaomi MiMo. v2.5 / v2.5-pro both ship 1M tokens; the older 7B-RL series
  // is 32k. Match the v2.5 family first by substring.
  ["mimo-v2.5", 1_000_000],
  ["mimo", 32_768],
  ["mistral-large", 128_000],
  ["mistral", 32_768],
  ["gemini-2", 1_000_000],
  ["gemini", 1_000_000],
];
