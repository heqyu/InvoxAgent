// 构造 session/new、session/load 响应中的 ACP 配置项：
//   - SessionModelState  —— 顶部 model 下拉
//   - SessionConfigOption[] —— 底部工具栏额外下拉（Model / Agent | System Prompt / Thinking）
//
// 抽出原因（A2）：
//   这些纯 view-model 构造函数对 InvoxAgent 实例只是只读依赖（models /
//   configs 字段 + Session 字段），抽成 free function 后 agent.ts 的体积
//   下降，且单测 / 后续 prompt-loop 模块若要构造同样的视图也可以直接调用。
//
// Agent ↔ System Prompt 互斥（Phase G）：
//   agents 非空（默认情况，至少 4 内置）→ 暴露 "Agent" 下拉，
//   隐藏 "System Prompt" 下拉，避免双重控制冲突。
//   agents 为空 → 沿用旧 "System Prompt" 路径，保持向后兼容。

import type {
  SessionConfigOption,
  SessionModelState,
} from "@agentclientprotocol/sdk";
import type {
  AgentConfigOptions,
  AgentModelConfig,
  Session,
} from "./session-types.js";

/** 构造 session/new、session/load 响应中的 SessionModelState。 */
export function buildModelState(
  session: Session,
  models: AgentModelConfig,
): SessionModelState {
  return {
    availableModels: models.available,
    currentModelId: session.selectedModel ?? models.defaultModelId,
  };
}

/**
 * 构造 session/new、session/load 响应中的 SessionConfigOption[] ——
 * 客户端底部工具栏据此渲染额外下拉项（"Model"、"Agent"|"System Prompt"、"Thinking"）。
 *
 * category 选取：
 *   - model         —— ACP 稳定 category；当 configOptions 非空时 Zed 工具栏
 *                      会用 config_options_view 替代原生 model_selector
 *                      （二者互斥，见 thread_view.rs:3811）
 *   - agent         —— 自由 string category（ACP forward-compat），客户端不识别
 *                      时降级为通用下拉，仍能切换
 *   - system_prompt —— ACP 保留 category，仅在 agents 为空时使用
 *   - thought_level —— ACP 稳定 category，覆盖 thinking / reasoning_effort
 */
export function buildConfigOptions(
  session: Session,
  models: AgentModelConfig,
  configs: AgentConfigOptions,
): SessionConfigOption[] {
  const opts: SessionConfigOption[] = [];

  // Model selector
  if (models.available.length > 1) {
    opts.push({
      id: "model",
      name: "Model",
      description: "LLM model used for the next turn.",
      category: "model",
      type: "select",
      // 来源 selectedModel，让两条路径（setSessionConfigOption 和
      // unstable_setSessionModel）保持同步
      currentValue: session.selectedModel ?? models.defaultModelId,
      options: models.available.map((m) => ({
        value: m.modelId,
        name: m.name ?? m.modelId,
      })),
    });
  }

  // Agent / System Prompt 二选一 —— Phase G 引入 Agent 后取代 System Prompt
  if (configs.agents.length > 0) {
    // Agent 路径（默认）：仅当 ≥ 2 才渲染下拉，单条无切换意义
    if (configs.agents.length >= 2) {
      const currentAgentId =
        session.configValues["agent"] ??
        configs.defaultAgentId ??
        configs.agents[0]!.id;
      opts.push({
        id: "agent",
        name: "Agent",
        description:
          "Switch the active agent template (system prompt + tool whitelist + MCP gate) for the next turn.",
        category: "agent",
        type: "select",
        currentValue: currentAgentId,
        options: configs.agents.map((a) => ({
          value: a.id,
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
        })),
      });
    }
  } else if (configs.systemPrompts.length > 1) {
    // 兼容路径：agents 为空时走旧 System Prompt 下拉
    opts.push({
      id: "system_prompt",
      name: "System Prompt",
      description: "Switch the system prompt template for the next turn.",
      category: "system_prompt",
      type: "select",
      currentValue:
        session.configValues.system_prompt ?? configs.defaultSystemPromptId,
      options: configs.systemPrompts.map((p) => ({
        value: p.id,
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
      })),
    });
  }

  // Thinking / reasoning 强度（永远公布；取值由上游 API 决定，硬编码）
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
