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
//   - **uiKind="other"**：tier 决定安全策略，kind 决定 UI 渲染。execute 类
//     在 Zed 里会被按 terminal 风格画成无展开按钮的 "Run Command" 头部 ——
//     SubAgent 既没 terminal 流又有大段进度行 / 末态文本要展示，必须用
//     "other" 让 Zed 渲染成通用可展开卡片
//   - title 优先用 description，让 UI 卡片有可读标签
//   - **动态描述**：工具 description 包含占位符 `{AGENT_LIST}`，在 prompt-loop
//     运行时根据实际加载的 agentRegistry 替换为真实的类型列表。这样项目级、
//     用户级自定义的 agent 都能自动出现在提示词中。

import type { ToolSpec } from "../llm/types.js";
import type { AgentTemplate } from "../agent/templates/index.js";

/**
 * 根据 agent 注册表动态生成 SubAgent 工具描述中的 agent 类型列表段落。
 *
 * 输入：agentRegistry（id → AgentTemplate 的 Map，可能来自项目级/用户级配置）
 * 输出：格式化的 Markdown 文本，列出每个 agent 的名称、工具白名单、用途说明
 *
 * 设计点：
 *   - 按 id 字母序排列，保持稳定可预测
 *   - 突出显示每个 agent 的 tools 和 mcp 配置，帮助 LLM 选择正确的类型
 *   - 对内置的 Worker/Plan/CodeReviewer/Ask 给出详细说明
 *   - 对用户自定义 agent 只列出基本信息（避免臆测其用途）
 *   - 当 registry 为空或未提供时返回兜底文本（告知 LLM 当前无可用模板）
 */
export function formatAgentListForDescription(
  agentRegistry?: ReadonlyMap<string, AgentTemplate>,
): string {
  // 无注册表 → 返回友好提示
  if (!agentRegistry || agentRegistry.size === 0) {
    return `- (No agent templates loaded — SubAgent is unavailable in this environment)\n`;
  }

  const lines: string[] = [];
  // 按 id 排序，确保每次生成的描述顺序一致
  const sortedIds = [...agentRegistry.keys()].sort();

  for (const id of sortedIds) {
    const tpl = agentRegistry.get(id);
    if (!tpl) continue;

    // 格式化工具列表
    const toolStr = formatToolsForAgent(tpl);
    // 格式化 MCP 开关
    const mcpStr = tpl.mcp === false ? ", MCP disabled" : ", MCP enabled";
    // 格式化 model 覆盖（如果有）
    const modelStr = tpl.model ? `, model: ${tpl.model}` : "";
    // 格式化描述（如果有）
    const descStr = tpl.description ? ` — ${tpl.description}` : "";

    lines.push(`- ${id}:${descStr} Tools: [${toolStr}]${mcpStr}${modelStr}`);
  }

  return lines.join("\n");
}

/**
 * 将 agent 的 tools 配置格式化为可读字符串。
 *
 * 处理各种合法语法：
 *   - undefined / 未设          → "*"（全部工具）
 *   - []                       → "(none)"（全禁用）
 *   - ["Read","Glob"]          → 逗号分隔的工具名
 *   - ["-Bash"]                → "All except: Bash"
 *   - ["*","-Edit"]            → "All except: Edit"
 */
function formatToolsForAgent(tpl: AgentTemplate): string {
  if (!tpl.tools || tpl.tools.length === 0) {
    return tpl.tools && tpl.tools.length === 0 ? "(none)" : "*";
  }

  // 检查是否是减法模式（含 "-" 前缀的项）
  const negatives = tpl.tools.filter((t) => t.startsWith("-"));
  if (negatives.length > 0) {
    const excluded = negatives.map((n) => n.slice(1)).join(", ");
    return `All except: ${excluded}`;
  }

  // 正常白名单模式
  return tpl.tools.join(", ");
}

/** SubAgent 工具描述中的占位符，运行时会被实际的 agent 列表替换 */
const AGENT_LIST_PLACEHOLDER = "{AGENT_LIST}";

/**
 * 构建 SubAgent 工具的完整描述（静态部分 + 动态 agent 列表）。
 *
 * 静态部分包含：
 *   - 工具概述和基本机制
 *   - 使用时机指导
 *   - 工作原理说明
 *   - 最佳实践建议
 *   - 参数定义
 *
 * 动态部分（AGENT_LIST_PLACEHOLDER）会在 prompt-loop 运行时替换为真实列表。
 */
const STATIC_DESCRIPTION_PREFIX =
  `Launch a subagent (a custom Agent template) to handle a focused, multi-step subtask. ` +
  `Each agent type has specific capabilities and tools available to it.\n\n` +
  `Available agent types and the tools they have access to:\n` +
  AGENT_LIST_PLACEHOLDER +
  `\n` +
  `When using the SubAgent tool, specify a subagent_type parameter to select which agent type to use.\n\n` +
  `## When to use\n\n` +
  `Reach for this when:\n` +
  `- The task matches an available agent type's specialization\n` +
  `- You have independent work to run in parallel\n` +
  `- Answering would mean reading across several files — delegate it and keep the conclusion, not the file dumps\n` +
  `- For a single-fact lookup where you already know the file/symbol/value, search directly instead\n\n` +
  `## How it works\n\n` +
  `- The subagent runs in an isolated history with its own system prompt and tool whitelist\n` +
  `- Its final message is returned to you as this tool's result; it is not shown to the user directly — relay what matters\n` +
  `- Subagents cannot spawn further subagents — recursion is forbidden\n` +
  `- Multiple subagents can be launched in parallel by sending multiple tool calls in one response\n` +
  `- Progress is shown in real-time in the parent tool card as ▸ lines (e.g., "▸ Read package.json")\n\n` +
  `## Best practices\n\n` +
  `- Be concrete and self-contained in the prompt — the subagent sees only what you write, plus its template's system prompt\n` +
  `- For Plan agents: specify investigation scope and desired output format clearly\n` +
  `- For CodeReviewer agents: specify review focus (diff/targeted/whole-project) and severity scheme if non-standard\n` +
  `- For Worker agents: break large tasks into focused subtasks rather than delegating vague "do everything" requests`;
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";
import { buildSubAgentBanner } from "../agent/sub-agent-runner.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "SubAgent",
    description: STATIC_DESCRIPTION_PREFIX,
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
            "Full task instruction for the subagent. Sent as the subagent's single user message — be concrete and self-contained. Include context, constraints, expected output format, and any relevant file paths or code snippets the subagent needs.",
        },
        subagent_type: {
          type: "string",
          description:
            "The type of specialized agent to use for this task. Must match one of the loaded agent template IDs (see available agent types in tool description). Choose based on task nature — see agent type descriptions above for guidance.",
        },
        model: {
          type: "string",
          description:
            "Optional model override for this subagent run. Takes precedence over the agent template's model field. If omitted, uses the agent definition's model (if configured), then falls back to the parent session's model.",
        },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
};

/**
 * 根据 agentRegistry 动态构建 SubAgent 工具的 ToolSpec。
 *
 * 此函数将 STATIC_DESCRIPTION_PREFIX 中的 AGENT_LIST_PLACEHOLDER 替换为
 * 实际的 agent 类型列表，生成完整的、运行时准确的工具描述。
 *
 * 调用时机：prompt-loop 的 runOneIteration 中，在构建 allTools 之前调用，
 * 确保 LLM 每次看到的 SubAgent 描述都反映当前环境实际可用的 agent 模板。
 */
export function buildDynamicSubAgentSpec(
  agentRegistry?: ReadonlyMap<string, AgentTemplate>,
): ToolSpec {
  const agentList = formatAgentListForDescription(agentRegistry);
  return {
    ...spec,
    function: {
      ...spec.function,
      description: STATIC_DESCRIPTION_PREFIX.replace(
        AGENT_LIST_PLACEHOLDER,
        agentList,
      ),
    },
  };
}

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
      "other",
      titleBase,
    );
  }

  if (!subagentType) {
    return errorResult("missing 'subagent_type'", "other", titleBase);
  }
  if (!prompt || !prompt.trim()) {
    return errorResult("missing 'prompt'", "other", titleBase);
  }

  // 实际跑 subagent —— runner 内部捕获所有异常，永不抛错
  // 把父 toolCallId 透传给 runner，让它在跑过程中向父工具卡的 content 实时
  // 追加进度行（"▸ Glob **/*.ts" / "▸ Read package.json" 之类），用户在父
  // UI 上能看到正在执行的内部工具，subagent 跑完后由父 prompt-loop 的末态
  // tool_call_update 一并覆盖为 final acpContent
  const runResult = await ctx.subAgentRunner(
    {
      subagentType,
      prompt,
      parentToolCallId: ctx.toolCallId,
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
    const logHint = runResult.logPath ? `\n\n(log: ${runResult.logPath})` : "";
    return errorResult(
      reason + logHint,
      "other",
      `${titleBase} (${subagentType})`,
    );
  }

  // 成功：拼装两份文本：
  //
  //   - resultText（喂给父 LLM 的工具结果）：紧凑 header + finalText。**不含**
  //     进度行 —— 否则 audit 列表会污染父 LLM 的 context，且每条进度都用
  //     token，浪费成本。
  //   - acpContent（UI 渲染的末态工具卡）：**只保留日志路径**。运行过程中工具
  //     卡 content 会被 progress emitter 实时更新成 ▸ 进度行，让用户看到正在跑
  //     什么；subagent 收尾后由父 prompt-loop 用本 acpContent 覆盖中间状态，把
  //     工具卡缩成一行日志路径指针。设计意图：
  //       · finalText 已经在主对话流里给到父 LLM、UI 也会显示父 LLM 的下一条
  //         回复（往往直接复述 subagent 结论），工具卡不必重复
  //       · 进度审计轨迹真要回看 → 直接打开日志文件，不需要塞回工具卡
  //       · 退出 banner（runner 发的 thinking 块）已经把 token / time / log
  //         路径都摘要到线程里，工具卡只做"回到日志"的指针
  const headerLines: string[] = [
    `[subagent: ${subagentType}] (${runResult.iterations} iter, ${runResult.stopReason})`,
  ];
  if (runResult.logPath) {
    headerLines.push(`[log: ${runResult.logPath}]`);
  }
  const header = headerLines.join("\n");
  const body =
    runResult.finalText.trim() || "(subagent produced no final message)";
  const resultText = `${header}\n\n${body}`;

  // UI 末态：banner 摘要（token / time / stopReason）+ 进度审计轨迹。
  // banner 放在工具卡而非 agent_thought_chunk（Thinking 块），避免多个
  // 并行 SubAgent 的 banner 在 Zed UI 里叠成一坨。
  const bannerText = buildSubAgentBanner({
    subagentType,
    stopReason: runResult.stopReason,
    iterations: runResult.iterations,
    elapsedMs: runResult.elapsedMs,
    input: runResult.input,
    output: runResult.output,
    total: runResult.total,
    ...(runResult.logPath ? { logPath: runResult.logPath } : {}),
    ...(runResult.error ? { error: runResult.error } : {}),
  });
  const acpParts: {
    type: "content";
    content: { type: "text"; text: string };
  }[] = [{ type: "content", content: { type: "text", text: bannerText } }];
  // 进度审计轨迹：subagent 跑了哪些内部工具，一目了然
  if (runResult.progressLines && runResult.progressLines.length > 0) {
    const progressBlock = runResult.progressLines.join("  \n");
    acpParts.push({
      type: "content",
      content: { type: "text", text: progressBlock },
    });
  }

  return {
    resultText,
    acpContent: acpParts,
    kind: "other",
    title: `${titleBase} (${subagentType})`,
    ok: true,
  };
}

export const subAgentTool: Tool = {
  name: "SubAgent",
  tier: "execute",
  uiKind: "other",
  spec,
  execute,
};
