// MakePlan 工具：把 Plan Agent 的规划结果落盘到 <cwd>/.invox/plans/<theme>.md。
//
// 当 activeAgentId === "BDD" 时，写入前会校验 BDD 计划的必要段落
// （Scenario-to-stage mapping、Goal、Staged plan 等），缺失则拒绝写入
// 并返回具体的缺什么 + 补什么的指引，让 LLM 能自我纠正。

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import { isInsideWorkspace, readFileDirect } from "./fs-utils.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

// ── BDD 计划校验 ────────────────────────────────────────────────────

/**
 * BDD agent 的 MakePlan 必须包含的 section。
 *
 * 每条规则 = { heading: 匹配模式, required: true/false, hint: 缺失时给 LLM 的提示 }。
 * 校验方式：在 markdown content 里按 heading 关键词做包含匹配（大小写不敏感），
 * 不要求严格的 heading 层级 —— 给 LLM 留适度自由度。
 */
interface BddSectionRule {
  /** 匹配模式（regex）。会在 content 中 search。 */
  pattern: RegExp;
  /** 是否必须存在。 */
  required: boolean;
  /** 缺失时的 LLM 可读提示。 */
  hint: string;
}

const BDD_PLAN_SECTIONS: BddSectionRule[] = [
  // ── BDD 核心：用户故事 ──────────────────────────────────────────
  {
    pattern: /as\s+a\b/i,
    required: true,
    hint:
      '缺少 User Story。请在计划开头添加：\n' +
      'As a [角色], I want [功能], So that [价值]。',
  },
  // ── BDD 核心：Gherkin 场景 ─────────────────────────────────────
  {
    pattern: /scenario|given[\s:].*when[\s:].*then[\s:]/is,
    required: true,
    hint:
      "缺少 Gherkin 场景（Given-When-Then）。请在计划中嵌入至少一个" +
      "可执行的行为场景，格式如：\n  Given ...\n  When ...\n  Then ...",
  },
  // ── BDD ↔ Staged Build 桥梁：场景-阶段映射 ────────────────────
  {
    pattern:
      /scenario[\s-]*to[\s-]*stage|场景[\s-]*[↔→<\-]+[\s-]*阶段|scenario.*stage.*map/i,
    required: true,
    hint:
      "缺少 Scenario-to-stage mapping（场景-阶段映射表）。" +
      "这是 BDD 与分阶段构建的核心桥梁。请添加一个表格，说明" +
      "哪个 .feature 场景在哪一阶段被验证。",
  },
  // ── 分阶段计划 ─────────────────────────────────────────────────
  {
    pattern: /stage\s*\d|阶段\s*\d|分阶段|staged?\s+plan/i,
    required: true,
    hint:
      "缺少分阶段计划（Staged plan）。请按 Stage 1 / Stage 2 / ... " +
      "列出实现步骤，每阶段必须是一个可运行的 demo。",
  },
  // ── 目标 ────────────────────────────────────────────────────────
  {
    pattern: /^#+\s*goal|^#+\s*目标/im,
    required: true,
    hint: "缺少 Goal / 目标段落。请重述需求并链接到 .feature 文件。",
  },
  // ── 决策日志 ────────────────────────────────────────────────────
  {
    pattern: /decision|决策|why|理由|选择/i,
    required: false,
    hint:
      "（建议）缺少决策日志（Decision log）。对于每个关键设计选择，" +
      '请记录「选了什么 + 为什么」，供未来自己复盘。',
  },
  // ── 已知陷阱 ────────────────────────────────────────────────────
  {
    pattern: /pitfall|陷阱|风险|risk|注意/i,
    required: false,
    hint:
      "（建议）缺少已知陷阱（Known pitfalls）。请列出这类问题的经典" +
      "踩坑点，表格式：陷阱 | 症状 | 预防。",
  },
  // ── 测试策略 ────────────────────────────────────────────────────
  {
    pattern: /test.*strateg|测试策略|cargo\s+test|vitest|jest|测试框架/i,
    required: true,
    hint:
      "缺少测试策略（Test strategy）。请说明：\n" +
      "1. 使用什么测试框架（cargo test / vitest / jest）\n" +
      "2. 测试文件放在哪里（tests/ / __tests__/）\n" +
      "3. 如何运行测试（完整的命令）",
  },
  // ── 验证命令 ────────────────────────────────────────────────────
  {
    pattern:
      /验证命令|verify.*command|cargo\s+test|vitest\s+run|npm\s+run\s+test/i,
    required: true,
    hint:
      "缺少验证命令（Verification commands）。每个 Stage 节点必须声明\n" +
      "具体的验证命令（如 `cargo test test_basic_search` 或 `vitest run`）。\n" +
      "仅写「验证场景: xxx」不够，必须有可执行的命令。",
  },
];

/** 校验 BDD agent 的 plan 内容，返回所有缺失项。 */
function validateBddPlan(content: string): BddSectionRule[] {
  const missing: BddSectionRule[] = [];
  for (const rule of BDD_PLAN_SECTIONS) {
    if (!rule.pattern.test(content)) {
      missing.push(rule);
    }
  }
  return missing;
}

/**
 * 把缺失项渲染成 LLM 可读的纠错指引。
 *
 * 格式分两段：
 *   1. 必须修复项（required: true）—— 阻断写入
 *   2. 建议补充项（required: false）—— 不阻断，仅供参考
 */
function formatBddValidationErrors(
  missing: BddSectionRule[],
): string {
  const required = missing.filter((r) => r.required);
  const optional = missing.filter((r) => !r.required);

  const lines: string[] = [
    "BDD Plan 校验失败 —— 以下必要段落缺失：\n",
  ];

  for (let i = 0; i < required.length; i++) {
    lines.push(`${i + 1}. ${required[i]!.hint}\n`);
  }

  if (optional.length > 0) {
    lines.push("\n（以下为建议补充，不阻断写入：）\n");
    for (const r of optional) {
      lines.push(`- ${r.hint}`);
    }
  }

  lines.push(
    "\n请补充上述必要段落后重新调用 MakePlan。",
  );

  return lines.join("\n");
}

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "MakePlan",
    description:
      "Persist a Markdown plan into <cwd>/.invox/plans/<theme>.md. " +
      "Use this in Plan mode after investigation to save the final written plan. " +
      "The theme must be a file stem, not a path.",
    parameters: {
      type: "object",
      properties: {
        theme: {
          type: "string",
          description:
            "Plan theme used as the file name stem. The output path is always <cwd>/.invox/plans/<theme>.md.",
        },
        content: {
          type: "string",
          description: "Full Markdown content of the plan.",
        },
      },
      required: ["theme", "content"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const themeResult = normalizeTheme(args["theme"]);
  if (!themeResult.ok)
    return errorResult(themeResult.error, "edit", "MakePlan");

  if (typeof args["content"] !== "string") {
    return errorResult("missing 'content'", "edit", "MakePlan");
  }
  const content = args["content"];
  if (!content.trim())
    return errorResult("missing 'content'", "edit", "MakePlan");

  // ── BDD 模式下校验计划内容 ──────────────────────────────────────
  if (ctx.activeAgentId === "BDD") {
    const missing = validateBddPlan(content);
    const requiredMissing = missing.filter((r) => r.required);
    if (requiredMissing.length > 0) {
      const errMsg = formatBddValidationErrors(missing);
      log.warn("MakePlan: BDD validation failed", {
        missing: requiredMissing.map((r) => r.hint.slice(0, 60)),
      });
      return errorResult(errMsg, "edit", `MakePlan: ${themeResult.theme}`);
    }
    // required 都过了，但有 optional 缺失 → warn 但不阻断
    const optionalMissing = missing.filter((r) => !r.required);
    if (optionalMissing.length > 0) {
      log.info("MakePlan: BDD plan missing optional sections", {
        hints: optionalMissing.map((r) => r.hint.slice(0, 60)),
      });
    }
  }

  const theme = themeResult.theme;

  const path = resolve(ctx.cwd, ".invox", "plans", `${theme}.md`);
  const plansDir = resolve(ctx.cwd, ".invox", "plans");
  const rel = `.invox/plans/${theme}.md`;

  if (!isInsideWorkspace(path, plansDir)) {
    return errorResult(
      "theme must resolve inside .invox/plans",
      "edit",
      `MakePlan: ${theme}`,
    );
  }
  if (!isInsideWorkspace(path, ctx.cwd)) {
    return errorResult(
      "target path must stay inside workspace",
      "edit",
      `MakePlan: ${theme}`,
    );
  }
  if (!ctx.caps.fs?.writeTextFile) {
    log.debug("MakePlan: ACP fs.writeTextFile capability missing", { path });
    return errorResult(
      "client does not advertise fs.writeTextFile capability",
      "edit",
      `MakePlan: ${theme}`,
    );
  }

  let oldText: string | null = null;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    oldText = cached.content;
  } else {
    try {
      if (ctx.caps.fs?.readTextFile) {
        const r = await ctx.conn.readTextFile({
          sessionId: ctx.sessionId,
          path,
        });
        oldText = r.content;
      } else {
        oldText = await readFileDirect(path);
      }
    } catch {
      oldText = null;
    }
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
  } catch (e) {
    log.debug("MakePlan: write FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `write failed: ${(e as Error).message}`,
      "edit",
      `MakePlan: ${theme}`,
    );
  }

  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);
  log.debug("MakePlan: completed", { path, bytes: content.length });

  return {
    resultText: `saved plan to ${rel} (${content.length} bytes)`,
    acpContent: [
      {
        type: "diff",
        path,
        oldText,
        newText: content,
      },
    ],
    kind: "edit",
    title: oldText === null ? `Created plan ${theme}` : `Updated plan ${theme}`,
    locations: [{ path }],
    ok: true,
  };
}

function normalizeTheme(
  raw: unknown,
): { ok: true; theme: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "missing 'theme'" };
  const input = raw.trim();
  if (!input) return { ok: false, error: "missing 'theme'" };

  const theme = input.endsWith(".md") ? input.slice(0, -3).trim() : input;

  if (!theme) return { ok: false, error: "missing 'theme'" };
  if (theme === "." || theme === "..") {
    return { ok: false, error: "theme must be a file name stem, not a path" };
  }
  if (/[<>:"/\\|?*\x00-\x1F]/.test(theme)) {
    return {
      ok: false,
      error:
        "theme must not contain path separators or invalid filename characters",
    };
  }

  return { ok: true, theme };
}

export const makePlanTool: Tool = {
  name: "MakePlan",
  tier: "write",
  spec,
  execute,
};
