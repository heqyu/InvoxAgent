import type { AgentTemplate } from "./types.js";
import { WORKER_PROMPT } from "./prompts/worker.js";
import { PLAN_PROMPT } from "./prompts/plan.js";
import { ASK_PROMPT } from "./prompts/ask.js";
import { CODE_REVIEWER_PROMPT } from "./prompts/code-reviewer.js";
import { BDD_PROMPT } from "./prompts/bdd.js";

// ── 内置兜底 ─────────────────────────────────────────────────────────

/**
 * 仅内置 Worker —— 全工具开放的通用工作模式，作为最小兜底。
 *
 * 其余三个角色（Plan / Ask / CodeReviewer）由用户级配置提供：
 *   ~/.invox/agents/Plan.json
 *   ~/.invox/agents/Ask.json
 *   ~/.invox/agents/CodeReviewer.json
 *
 * 首次调用 loadAgentTemplates 时会自动 seed 这三个文件（若不存在）。
 */
// Worker 的 system prompt —— 通用编码工作模式。
//
// 设计取舍（为什么要写这么长）：
//   1. 短 prompt（如旧版 4 行）让模型回退到训练时的"通用助手"先验：
//      废话多、串行调工具、贴大段代码、加 emoji。明确写下规则才能压住。
//   2. 把"行为契约"按 9 个 section 列清，attention 路径更稳：
//      Identity / Env / Communication / Tools / Editing / Search /
//      Bash / ProjectContext / SelfCorrection。
//   3. 每条规则尽量给"为什么" + "怎么做"，避免被模型当作软建议忽略。
export const BUILTIN_AGENTS: AgentTemplate[] = [
  {
    id: "Worker",
    name: "Worker",
    description: "完全开放：可读写文件、执行命令、用 MCP —— 默认通用工作模式。",
    prompt: WORKER_PROMPT,
    // tools 未设 = 全部内置；mcp 未设 = 允许
    // model = "$MODEL_LITE"：Worker 是"按计划干活"的角色，用 LITE
    // 模型节省 token；agentModels.LITE 未设时回退 session 当前 model。
    model: "$MODEL_LITE",
  },
];

// ── 用户目录 seed ────────────────────────────────────────────────────

/**
 * 首次加载时自动在 ~/.invox/agents/ 下生成 Plan / Ask / CodeReviewer
 * 三个默认配置文件。已存在则跳过，不覆盖用户自定义。
 *
 * 升级提示：如果你已经被 seed 过旧版 prompt，**新版 prompt 不会自动生效**——
 * seed 逻辑保护用户自定义不被覆盖。要用上最新内置 prompt，请删除：
 *   ~/.invox/agents/{Plan,Ask,CodeReviewer}.json
 * 然后重启 invox（Zed 下：`npm run restart`）。下次启动会重新 seed。
 */
export const DEFAULT_USER_AGENTS: Array<
  Omit<AgentTemplate, "id"> & { id: string }
> = [
  {
    id: "Plan",
    name: "Plan",
    description:
      "只读勘察 + 方案落盘：Read / Glob / Grep / Skill 调研，MakePlan 写入 .invox/plans。",
    prompt: PLAN_PROMPT,
    tools: ["Read", "Glob", "Grep", "Skill", "MakePlan"],
    // Plan 需要"高度推理规划"能力 → 默认指向 agentModels.PRO
    model: "$MODEL_PRO",
  },
  {
    id: "Ask",
    name: "Ask",
    description: "轻量问答：可用 Read 读文件，但不能编辑、搜索或执行命令。",
    prompt: ASK_PROMPT,
    tools: ["Read"],
    mcp: false,
    // Ask 不设 model：轻量问答，质量取决于用户当前选用的 model；
    // 让用户在 model 下拉里自由选择，agent 不强加偏好。
  },
  {
    id: "CodeReviewer",
    name: "Code Reviewer",
    description:
      "代码审查：只读 + Bash（跑 git diff / lint），禁止修改文件，对抗式严审。",
    prompt: CODE_REVIEWER_PROMPT,
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
    // Review 需要审视、对抗式分析 → 默认指向 PRO
    model: "$MODEL_PRO",
  },
  {
    id: "BDD",
    name: "BDD",
    description:
      "BDD 驱动开发：行为规格先行（Given-When-Then），结合结构化分层构建与自我约束方法论，" +
      "适合中大型功能的端到端交付。",
    prompt: BDD_PROMPT,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill", "MakePlan"],
    // BDD 需要"规格设计 + 分阶段规划 + 代码实现"全流程能力 → 默认 PRO
    model: "$MODEL_PRO",
  },
];
