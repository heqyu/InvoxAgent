// Agent 模板的类型定义 —— 纯类型，零运行时依赖。

/**
 * 一份 agent 模板 —— 落到 ACP 下拉的一行。
 *
 * 字段语义：
 *   - tools 未设 / `["*"]` → 暴露全部内置工具
 *   - tools `["Read","Glob"]` → 严格白名单
 *   - tools `["-Bash","-Write"]` 或 `["*","-Bash"]` → 全集做减法
 *   - mcp 未设 → true（不限制）；false → 完全屏蔽 MCP 工具暴露给 LLM
 *   - model 未设 → 走 session 当前 model（用户在 model 下拉里选的）
 *     具体 id："gpt-4o" / "qwen3-coder-30b" / 任何 provider 认识的字符串
 *     env 引用：
 *       "$MODEL_PRO"   → INVOX_MODEL_PRO 优先，回退 MODEL_PRO
 *       "$MODEL_LITE"  → INVOX_MODEL_LITE 优先，回退 MODEL_LITE
 *       "$ANY_VAR"     → process.env.ANY_VAR
 *     env 解析失败时：warn + 回退 session 当前 model（不让 agent 切换报错）
 *
 * Memory / Skills 段不写入 prompt 本身 —— 它们由
 * systemMessageWithMemoryAndSkills 在每次 turn 自动追加。
 */
export type AgentSource = "builtin" | "user" | "project";

export interface AgentTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  mcp?: boolean;
  model?: string;
  /** 来源层级：builtin（内置兜底）、user（~/.invox/agents）、project（项目 .invox/agents）。 */
  source?: AgentSource;
}
