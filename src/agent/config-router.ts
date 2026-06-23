// ConfigRouter — 会话配置变更的单一入口。
//
// 从 InvoxAgent / SessionLifecycle 抽出（J2.4b），负责：
//   - applyAgentModel：把 agent.model 解析并应用到 session.selectedModel
//   - activeAgentFor：查询当前会话激活的 agent 模板
//   - applyConfigChange：处理 setSessionConfigOption 的 4 个分支
//     （model / agent / system_prompt / thinking）
//
// system prompt 主体计算由 SystemPromptComposer（J3.2）负责。
// ConfigRouter 在 agent/system_prompt 分支通过 composer.refresh() 刷新 history[0]。
//
// 设计：ConfigRouter 不持有 session 注册表或生命周期状态，只负责
// "给定 session + config change → 应用到 session 上"的纯配置逻辑。

import { THINKING_VALUES } from "./system-prompt.js";
import {
  configMode,
  type AgentConfigOptions,
  type AgentModelConfig,
  type Session,
  type SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";
import { resolveAgentModel } from "./templates/index.js";
import type { SystemPromptComposer } from "./system-prompt-composer.js";
import { createLogger } from "../log.js";

const log = createLogger("agent");

export class ConfigRouter {
  constructor(
    private readonly configs: AgentConfigOptions,
    private readonly models: AgentModelConfig,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
    private readonly systemPromptById: ReadonlyMap<string, SystemPromptDef>,
    private readonly availableModelIds: Set<string>,
    private readonly composer: SystemPromptComposer,
  ) {}

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
    if (configMode(this.configs) !== "agent") return undefined;
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
      if (configMode(this.configs) !== "agent") {
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
      // 就地替换 history[0]：通过 composer 统一构造 system message
      this.composer.refresh(session);
      // Phase H：同步切换 model —— agent.model 解析后写入 session.selectedModel
      this.applyAgentModel(session, agent);
    } else if (configId === "system_prompt") {
      if (configMode(this.configs) === "agent") {
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
      // 就地替换 history[0]：通过 composer 统一构造 system message
      this.composer.refresh(session);
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
