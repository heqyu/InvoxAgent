// SystemPromptComposer — history[0] 构造的单一入口。
//
// 从 ConfigRouter / SessionLifecycle 抽出（J3.2），负责：
//   - computeFor：给定 session 计算当前 system message
//   - refresh：就地刷新 session.history[0]
//   - effectiveBody：根据 configValues 取 prompt 主体
//
// 所有"换 agent / 换 prompt / loadSession 刷新"路径都走本类，
// 确保 history[0] 的构造逻辑只有一份。

import type { LLMMessage } from "../llm/types.js";
import { systemMessageWithMemoryAndSkills } from "./system-prompt.js";
import {
  configMode,
  type AgentConfigOptions,
  type Session,
  type SystemPromptDef,
} from "./session-types.js";
import type { AgentTemplate } from "./templates/index.js";

export class SystemPromptComposer {
  constructor(
    private readonly configs: AgentConfigOptions,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
    private readonly systemPromptById: ReadonlyMap<string, SystemPromptDef>,
  ) {}

  /** 计算给定 session 当前应当使用的 system message。 */
  computeFor(session: Session): LLMMessage {
    const body = this.effectiveBody(session.configValues);
    return systemMessageWithMemoryAndSkills(body, session.cwd);
  }

  /** 就地刷新 session.history[0]。 */
  refresh(session: Session): void {
    session.history[0] = this.computeFor(session);
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
  effectiveBody(configValues: Record<string, string>): string {
    if (configMode(this.configs) === "agent") {
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
}
