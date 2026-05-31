// Tool registry — the single place that lists every tool.
//
// Adding a new tool: write src/tools/<name>.ts that exports `Tool`, then
// add it to TOOLS below. The router auto-discovers via name.

import type { ToolSpec } from "../llm/types.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import type { Tool } from "./types.js";

export const TOOLS: readonly Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
];

const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

/** Look up a tool by name; returns undefined if unknown. */
export function getTool(name: string): Tool | undefined {
  return TOOL_BY_NAME.get(name);
}

/** OpenAI specs for all registered tools — passed to the LLM. */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);
