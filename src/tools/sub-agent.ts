// SubAgent 工具：让 LLM 委派一个子任务给指定的 Agent 模板。
//
// 设计点：
//   - 工具暴露给 LLM 的参数模仿 Claude Code 的 Agent 工具：description /
//     prompt / subagent_type / model；保留对方常见用法语感
//   - 实际执行靠 ToolExecContext.subAgentRunner 闭包；该闭包由父 prompt-loop
//     在调用 executeTool 时按需构造，保证 subagent 内部调用本工具时 runner
//     为 undefined（递归屏障）
//   - tier="execute"：subagent 可以触发任意工具，理应当作执行类（按权限策略
//     的"writes/always"会要求一次许可；"never" 默认放行）
//   - title 优先用 description，让 UI 卡片有可读标签

import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "SubAgent",
    description:
      "Launch a subagent (a custom Agent template) to handle a focused, multi-step subtask. " +
      "The subagent runs with its own system prompt and tool whitelist (defined by the chosen template) " +
      "in an isolated history, then returns its final assistant message as this tool's result. " +
      "Use this to delegate self-contained jobs to specialised modes (e.g. \"Plan\" for read-only " +
      "investigation + plan file, \"CodeReviewer\" for review-only, \"Ask\" for pure Q&A, \"Worker\" " +
      "for full-power coding) without polluting the parent conversation. " +
      "Subagents cannot themselves spawn further subagents — recursion is forbidden.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "Short (3–5 word) human-readable name of the delegated task; shown in the UI tool card.",
        },
        prompt: {
          type: "string",
          description:
            "Full task instruction for the subagent. Sent as the subagent's single user message — be concrete and self-contained.",
        },
        subagent_type: {
          type: "string",
          description:
            "Agent template id, e.g. \"Plan\" / \"Ask\" / \"CodeReviewer\" / \"Worker\". Must match one of the loaded agents (project-level or user-level under .invox/agents/).",
        },
        model: {
          type: "string",
          description:
            "Optional model id override for this subagent run. Falls back to the agent template's `model` field, then to the parent session's currently selected model.",
        },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  // 解析参数 —— 全部作为字符串读入，缺失或类型不符返回结构化错误
  const description =
    typeof args["description"] === "string" ? args["description"].trim() : "";
  const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
  const subagentType =
    typeof args["subagent_type"] === "string"
      ? args["subagent_type"].trim()
      : "";
  const modelOverride =
    typeof args["model"] === "string" && args["model"].trim().length > 0
      ? args["model"].trim()
      : undefined;

  const titleBase = description || (subagentType ? subagentType : "SubAgent");

  // 递归屏障：runner 缺失时基本只可能是"在 subagent 内部又被调用"
  if (!ctx.subAgentRunner) {
    return errorResult(
      "SubAgent is unavailable in this context (recursive subagent calls are forbidden).",
      "execute",
      titleBase,
    );
  }

  if (!subagentType) {
    return errorResult("missing 'subagent_type'", "execute", titleBase);
  }
  if (!prompt || !prompt.trim()) {
    return errorResult("missing 'prompt'", "execute", titleBase);
  }

  // 实际跑 subagent —— runner 内部捕获所有异常，永不抛错
  const runResult = await ctx.subAgentRunner(
    {
      subagentType,
      prompt,
      ...(description ? { description } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    },
    ctx.signal,
  );

  // 失败：把错误原因作为 tool result 返还给父 LLM，让其自我纠错或换策略
  if (!runResult.ok) {
    const reason =
      runResult.error ??
      `subagent stopped with reason "${runResult.stopReason}"`;
    return errorResult(reason, "execute", `${titleBase} (${subagentType})`);
  }

  // 成功：拼装带 provenance header 的最终文本
  const header = `[subagent: ${subagentType}] (${runResult.iterations} iter, ${runResult.stopReason})`;
  const body =
    runResult.finalText.trim() || "(subagent produced no final message)";
  const resultText = `${header}\n\n${body}`;

  return {
    resultText,
    acpContent: [
      { type: "content", content: { type: "text", text: resultText } },
    ],
    kind: "execute",
    title: `${titleBase} (${subagentType})`,
    ok: true,
  };
}

export const subAgentTool: Tool = {
  name: "SubAgent",
  tier: "execute",
  spec,
  execute,
};
