// Config 选项选择函数 —— 从 cli.ts 抽出（J2.5）。
//
// pickConfigOptions / loadPromptTemplates / BUILTIN_SYSTEM_PROMPTS
// 负责根据环境变量和磁盘文件构造 AgentConfigOptions。

import {
  DEFAULT_SYSTEM_PROMPT,
  type AgentConfigOptions,
  type AgentTemplate,
  type SystemPromptDef,
} from "../agent/agent.js";
import { loadAgentTemplates } from "../agent/templates/index.js";
import { loadJsonArray } from "../util/load-json-array.js";

export const BUILTIN_SYSTEM_PROMPTS: SystemPromptDef[] = [
  {
    id: "default",
    name: "Default",
    description: "Helpful coding assistant — uses tools first, explains after.",
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    id: "concise",
    name: "Concise",
    description: "Brief responses with minimal narration.",
    prompt:
      `You are a coding assistant in Zed. Be brief.\n` +
      `Use tools first; explain only when asked. Reply in 1-3 sentences unless code is required.`,
  },
  {
    id: "review",
    name: "Strict Review",
    description:
      "Adversarial code reviewer — quotes file paths and flags risks.",
    prompt:
      `You are a senior code reviewer in Zed. Adopt a skeptical, evidence-first stance.\n` +
      `Always quote file paths and line numbers. Flag risks before suggesting changes. ` +
      `Read code with the Read tool before commenting on it.`,
  },
];

/**
 * 从 INVOX_PROMPT_TEMPLATES_FILE 环境变量加载自定义 system prompt 模板。
 * 未设环境变量时返回 BUILTIN_SYSTEM_PROMPTS。
 *
 * 使用 loadJsonArray 消除与 templates/loader.ts 的结构重复。
 */
export function loadPromptTemplates(): SystemPromptDef[] {
  const file = process.env["INVOX_PROMPT_TEMPLATES_FILE"];
  if (!file) return BUILTIN_SYSTEM_PROMPTS;

  return loadJsonArray<SystemPromptDef>({
    filePath: file,
    fallback: BUILTIN_SYSTEM_PROMPTS,
    logScope: "cli",
    validate: (entry, _i) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { id?: unknown }).id !== "string" ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        typeof (entry as { prompt?: unknown }).prompt !== "string"
      ) {
        return null;
      }
      const e = entry as {
        id: string;
        name: string;
        description?: string;
        prompt: string;
      };
      return {
        id: e.id,
        name: e.name,
        ...(typeof e.description === "string"
          ? { description: e.description }
          : {}),
        prompt: e.prompt,
      };
    },
  });
}

/**
 * 构造 ACP `setSessionConfigOption` 暴露的下拉项。
 *
 * Phase G 路径选择：
 *   - 检测到任何 agent 模板（项目级 / 用户级 / 内置兜底）→ 走 Agent 路径
 *   - 用户显式 `INVOX_AGENTS=disabled` → agents 数组为空，回退旧 system_prompt 路径
 */
export function pickConfigOptions(): AgentConfigOptions {
  const systemPrompts = loadPromptTemplates();
  const defaultSystemPromptId = systemPrompts[0]!.id; // load() 总能返回 ≥ 1 条

  // INVOX_AGENTS=disabled 用作"我就要用旧 system_prompt 下拉"的逃生阀
  const agentsDisabled =
    (process.env["INVOX_AGENTS"] ?? "").toLowerCase() === "disabled";

  let agents: AgentTemplate[] = [];
  let defaultAgentId: string | undefined;
  if (!agentsDisabled) {
    const scanRoot = process.env["INVOX_AGENTS_DIR"] ?? process.cwd();
    agents = loadAgentTemplates(scanRoot);
    if (agents.length > 0) {
      const envDefault = process.env["INVOX_DEFAULT_AGENT"];
      if (envDefault && agents.some((a) => a.id === envDefault)) {
        defaultAgentId = envDefault;
      } else {
        defaultAgentId =
          agents.find((a) => a.id === "Worker")?.id ?? agents[0]!.id;
      }
    }
  }

  return {
    systemPrompts,
    defaultSystemPromptId,
    agents,
    ...(defaultAgentId ? { defaultAgentId } : {}),
  };
}
