// 工具注册表 —— 唯一列出所有内置工具的位置。
//
// 新增工具：在 src/tools/ 下新建 <name>.ts 导出 Tool，再加进 TOOLS 即可，
// router 通过 name 自动派发。

import type { ToolSpec } from "../llm/types.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { makePlanTool } from "./make-plan.js";
import { readFileTool } from "./read-file.js";
import { skillTool } from "./skill.js";
import { subAgentTool } from "./sub-agent.js";
import { writeFileTool } from "./write-file.js";
import type { Tool } from "./types.js";

export const TOOLS: readonly Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  makePlanTool,
  globTool,
  grepTool,
  bashTool,
  skillTool,
  subAgentTool,
];

const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

/** 按名查工具；未找到返回 undefined。 */
export function getTool(name: string): Tool | undefined {
  return TOOL_BY_NAME.get(name);
}

/** 所有内置工具的 OpenAI 规范，传给 LLM 用。 */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);
