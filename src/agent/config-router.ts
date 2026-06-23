// ConfigRouter — 会话配置变更的单一入口。
//
// 从 InvoxAgent / SessionLifecycle 抽出（J2.4b），负责：
//   - effectiveSystemPromptBody：根据 configValues 计算 system prompt 主体
//   - applyAgentModel：把 agent.model 解析并应用到 session.selectedModel
//   - activeAgentFor：查询当前会话激活的 agent 模板
//   - applyConfigChange：处理 setSessionConfigOption 的 4 个分支
//     （model / agent / system_prompt / thinking）
//
// 设计：ConfigRouter 不持有 session 注册表或生命周期状态，只负责
// "给定 session + config change → 应用到 session 上"的纯配置逻辑。

import { systemMessageWithMemoryAndSkills, THINKING_VALUES } from "./system-prompt.js";
import type {
  AgentConfigOptions,
  AgentModelConfig,
  Session,
  SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";
import { resolveAgentModel } from "./templates/index.js";
import { createLogger } from "../log.js";

const log = createLogger("agent");

export class ConfigRouter {
  constructor(
    private readonly configs: AgentConfigOptions,
    private readonly models: AgentModelConfig,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
    private readonly systemPromptById: ReadonlyMap<string, SystemPromptDef>,
    private readonly availableModelIds: Set<string>,
  ) {}

  /**
   * 给定 configValues，计算应注入 history[0] 的 system prompt 主体（不含
   * memory / skills 段——那两段由 systemMessageWithMemoryAndSkills 自动追加）。
   *
   *   - agents 非空 → 取 configValues.agent 对应模板的 prompt
   *   - agents 为空 → 走旧 system_prompt 模板路径
   *
   * 任何路径都保证能取到值；configValues 中的 id 不在表里时回退到默认 id。
   */
  effectiveSystemPromptBody(configValues: Record<string, string>): string {
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
   *     也能展示新 id；防御性地避免 setSessionConfigOption("model") 路径被拒）
   *   - 解析后与原 selectedModel 相同 → 不更新（避免无效 log 噪音）
   *
   * 永不抛错：env 未设时 resolveAgentModel 内部 warn + 回退 fallback；
   * 这里再判一次"resolved 是否就是 fallback" —— 是则视作"agent 没有覆盖
   * 意图"，保留 selectedModel 现状。
   */
  applyAgentModel(session: Session, agent: AgentTemplate): void {
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

  /**
   * 当前会话激活的 agent 模板。
   *
   *   - agents 为空 → 返回 undefined（旧 system_prompt 路径）
   *   - configValues.agent 不在最新菜单 → 回退到 defaultAgentId
   */
  activeAgentFor(session: Session): AgentTemplate | undefined {
    if (this.configs.agents.length === 0) return undefined;
    const id = session.configValues["agent"] ?? this.configs.defaultAgentId!;
    return (
      this.agentById.get(id) ??
      this.agentById.get(this.configs.defaultAgentId!)
    );
  }

  /**
   * 处理 ACP `session/set_config_option` 的核心逻辑：4 个分支
   * （model / agent / system_prompt / thinking）。
   *
   * 调用方（InvoxAgent.setSessionConfigOption）负责：
   *   - session 查找 + 类型校验
   *   - persist + 返回 buildConfigOptions
   */
  applyConfigChange(
    session: Session,
    configId: string,
    value: string,
  ): void {
    if (configId === "model") {
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
    } else if (configId === "agent") {
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
    } else if (configId === "system_prompt") {
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
    } else if (configId === "thinking") {
      if (!THINKING_VALUES.has(value)) {
        throw new Error(
          `unknown thinking value: ${value} (allowed: ${[...THINKING_VALUES].join(", ")})`,
        );
      }
      session.configValues.thinking = value;
    } else {
      throw new Error(`unknown configId: ${configId}`);
    }
  }
}
