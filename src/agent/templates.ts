// 自定义 Agent 模板 —— Plan / Ask / Worker / CodeReviewer 等。
//
// 一个 Agent 模板 = 系统提示词 + 工具白名单 + MCP 开关。Session 一次只激活一个
// 模板（通过 ACP `setSessionConfigOption` 下拉切换）。
//
// 配置来源（高 → 低优先）：
//   1. 项目级：<cwd>/.invox/agents/*.json    —— 文件名（去 .json）即 id
//   2. 用户级：~/.invox/agents/*.json
//   3. 内置兜底：仅 Worker（Plan / Ask / CodeReviewer 由用户级 config 提供）
//
// 设计点：
//   - 单文件 = 单模板：增删一条 = 加删一个文件，无冲突
//   - 项目级 by id 覆盖用户级（与 plugins.json first-found-wins 同向）
//   - 一个文件解析失败仅 warn，其它继续 —— 一个坏 JSON 不拖崩启动
//   - 与 SystemPromptDef 兼容：Agent 是其超集（多了 tools、mcp 两字段）
//   - 首次加载自动 seed：~/.invox/agents/{Plan,Ask,CodeReviewer}.json
//
// 与 `system_prompt` 下拉互斥：当至少有一个 agent（含内置）时，agent.ts
// 走 agent 路径；agents 为空才回退到旧 system_prompt 路径。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";

// ── 类型 ──────────────────────────────────────────────────────────────

/**
 * 一份 agent 模板 —— 落到 ACP 下拉的一行。
 *
 * 字段语义：
 *   - tools 未设 / `["*"]` → 暴露全部内置工具
 *   - tools `["Read","Glob"]` → 严格白名单
 *   - tools `["-Bash","-Write"]` 或 `["*","-Bash"]` → 全集做减法
 *   - mcp 未设 → true（不限制）；false → 完全屏蔽 MCP 工具暴露给 LLM
 *
 * Memory / Skills 段不写入 prompt 本身 —— 它们由
 * systemMessageWithMemoryAndSkills 在每次 turn 自动追加。
 */
export interface AgentTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  mcp?: boolean;
}

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
export const BUILTIN_AGENTS: AgentTemplate[] = [
  {
    id: "Worker",
    name: "Worker",
    description: "完全开放：可读写文件、执行命令、用 MCP —— 默认通用工作模式。",
    prompt:
      `You are a coding assistant in Zed. Use tools first, explain after.\n` +
      `When the user attaches a file, Read it before answering. ` +
      `When asked to edit, Read first then Edit. ` +
      `Use Bash for any command-line task.`,
    // tools 未设 = 全部内置；mcp 未设 = 允许
  },
];

// ── 用户目录 seed ────────────────────────────────────────────────────

/**
 * 首次加载时自动在 ~/.invox/agents/ 下生成 Plan / Ask / CodeReviewer
 * 三个默认配置文件。已存在则跳过，不覆盖用户自定义。
 */
const DEFAULT_USER_AGENTS: Array<Omit<AgentTemplate, "id"> & { id: string }> = [
  {
    id: "Plan",
    name: "Plan",
    description:
      "只读勘察：仅 Read / Glob / Grep / Skill，绝不修改任何文件，专注产出方案。",
    prompt:
      `You are a planning assistant in Zed.\n` +
      `Your job is to analyze code and produce structured plans — never to modify files.\n` +
      `Use Read / Glob / Grep / Skill to gather facts. Cite file paths and line numbers in your plan.\n` +
      `If the user asks you to implement, refuse and explain you are in Plan mode; suggest switching to Worker mode.`,
    tools: ["Read", "Glob", "Grep", "Skill"],
  },
  {
    id: "Ask",
    name: "Ask",
    description: "纯问答：无任何工具，仅基于对话上下文与既有知识回答。",
    prompt:
      `You are a knowledgeable assistant. You have NO tools available.\n` +
      `Answer questions based purely on the conversation context and your training knowledge.\n` +
      `If a question requires reading files, executing commands, or searching the codebase, ` +
      `politely tell the user to switch to Worker or Plan mode.`,
    tools: [],
    mcp: false,
  },
  {
    id: "CodeReviewer",
    name: "Code Reviewer",
    description:
      "代码审查：只读 + Bash（跑 git diff / lint），禁止修改文件，对抗式严审。",
    prompt:
      `You are a senior code reviewer in Zed. Adopt a skeptical, evidence-first stance.\n` +
      `Always quote file paths and line numbers. Flag risks before suggesting changes.\n` +
      `Use Read / Glob / Grep / Bash (for git diff, lint, tests). Do NOT use Edit / Write — ` +
      `your job is to find issues, not fix them.`,
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
  },
];

/**
 * 在用户 home 目录下 seed 默认 agent 配置文件。
 * 目录不存在会创建；文件已存在则跳过（尊重用户自定义）。
 */
function seedDefaultAgents(): void {
  const userAgentsDir = join(homedir(), ".invox", "agents");
  if (!existsSync(userAgentsDir)) {
    try {
      mkdirSync(userAgentsDir, { recursive: true });
    } catch (e) {
      log.warn("agents: cannot create user agents dir", {
        dir: userAgentsDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  }

  for (const tpl of DEFAULT_USER_AGENTS) {
    const filePath = join(userAgentsDir, `${tpl.id}.json`);
    if (existsSync(filePath)) continue; // 已有 → 不覆盖

    const body: Record<string, unknown> = {
      name: tpl.name,
      prompt: tpl.prompt,
    };
    if (tpl.description) body.description = tpl.description;
    if (tpl.tools) body.tools = tpl.tools;
    if (tpl.mcp !== undefined) body.mcp = tpl.mcp;

    try {
      writeFileSync(filePath, JSON.stringify(body, null, 2) + "\n", "utf8");
      log.info("agents: seeded default agent config", { id: tpl.id, filePath });
    } catch (e) {
      log.warn("agents: failed to seed agent config", {
        id: tpl.id,
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ── 加载器 ────────────────────────────────────────────────────────────

const AGENT_DIR = join(".invox", "agents");

/**
 * 扫描某个根目录下的 .invox/agents/*.json，把文件解析成 AgentTemplate[]。
 * 解析失败的文件仅 warn 跳过；目录不存在直接返回空数组。
 *
 * 文件 schema：
 *   {
 *     "name": "Plan",                    // 必填
 *     "description": "...",              // 可选
 *     "prompt": "You are ...",           // 必填
 *     "tools": ["Read","Glob"],          // 可选
 *     "mcp": false                       // 可选，默认 true
 *   }
 *
 * 文件名（去 .json）作为 id —— 与 .invox/sessions/ 保持同惯例。
 * 文件内若再写 "id" 字段会被忽略，避免双源歧义。
 */
function loadAgentsFromDir(rootDir: string): AgentTemplate[] {
  const dir = join(rootDir, AGENT_DIR);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    log.warn("agents: cannot list dir", {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }

  const out: AgentTemplate[] = [];
  for (const name of entries) {
    if (extname(name) !== ".json") continue;
    const filePath = join(dir, name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const id = name.slice(0, -5); // 去 .json
    if (!isValidAgentId(id)) {
      log.warn("agents: skipping file with invalid id", { filePath, id });
      continue;
    }
    const tpl = parseAgentFile(filePath, id);
    if (tpl) out.push(tpl);
  }
  return out;
}

/** id 必须是非空 ASCII 安全字符 —— 作为下拉 value + ACP wire 字段。 */
function isValidAgentId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

function parseAgentFile(filePath: string, id: string): AgentTemplate | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    log.warn("agents: read failed", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn("agents: invalid JSON", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("agents: file is not a JSON object", { filePath });
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (typeof r["prompt"] !== "string" || r["prompt"].length === 0) {
    log.warn("agents: missing or empty 'prompt' field", { filePath });
    return null;
  }

  const tpl: AgentTemplate = {
    id,
    name:
      typeof r["name"] === "string" && r["name"].length > 0 ? r["name"] : id,
    prompt: r["prompt"] as string,
  };
  if (typeof r["description"] === "string") {
    tpl.description = r["description"];
  }
  if (Array.isArray(r["tools"])) {
    // 显式空数组 = 禁用全部，是合法语义；undefined 才表示"未设置 = 全部"。
    const tools: string[] = [];
    for (const t of r["tools"]) {
      if (typeof t === "string" && t.length > 0) tools.push(t);
    }
    tpl.tools = tools;
  }
  if (typeof r["mcp"] === "boolean") {
    tpl.mcp = r["mcp"];
  }
  return tpl;
}

/**
 * 加载所有 agent 模板：项目级 + 用户级 + 内置 —— 按 id 去重，**项目级覆盖
 * 用户级，用户级覆盖内置**。返回数组保持 [项目, 用户独有, 内置独有] 的稳定顺序，
 * 让下拉项位置随用户预期。
 *
 * 至少返回 BUILTIN_AGENTS（Worker）—— 任何路径都不会返回空数组。
 */
export function loadAgentTemplates(cwd: string): AgentTemplate[] {
  // 首次加载时自动 seed 用户目录默认配置（Plan / Ask / CodeReviewer）
  seedDefaultAgents();

  const projectAgents = loadAgentsFromDir(cwd);
  const userAgents = loadAgentsFromDir(homedir());

  const seen = new Set<string>();
  const out: AgentTemplate[] = [];
  // 项目级先入（最高优先）
  for (const a of projectAgents) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  // 用户级补漏
  for (const a of userAgents) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  // 内置兜底
  for (const a of BUILTIN_AGENTS) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }

  log.info("agents loaded", {
    cwd,
    total: out.length,
    project: projectAgents.length,
    user: userAgents.length,
    ids: out.map((a) => a.id),
  });
  return out;
}

// ── 工具白名单过滤 ────────────────────────────────────────────────────

/**
 * 按 agent.tools 过滤内置工具规范列表。
 *
 * 语法（在同一数组里混用合法）：
 *   undefined / ["*"]            → 全部内置工具
 *   []                           → 禁用全部内置工具
 *   ["Read","Glob"]              → 严格白名单
 *   ["-Bash"] / ["*","-Bash"]    → 在全集中减去（任意 "-X" 出现就视为
 *                                   "全集减法"模式，不要求显式 "*"）
 *   ["Read","-Edit"]             → 同时含正项与负项 → 警告，按"全集减法"处理
 *
 * 工具名严格匹配（PascalCase）；mismatch 仅 warn 跳过。
 *
 * 返回原 specs 的子集（不修改原数组）。
 */
export function filterToolSpecsByAgent(
  specs: readonly ToolSpec[],
  allow: string[] | undefined,
): ToolSpec[] {
  // case 1：未设 = 全部
  if (allow === undefined) return [...specs];

  // case 2：显式空数组 = 全禁
  if (allow.length === 0) return [];

  const allNames = new Set(specs.map((s) => s.function.name));

  // 区分正项 / 负项
  const positives: string[] = [];
  const negatives: string[] = [];
  let hasStar = false;
  for (const t of allow) {
    if (t === "*") {
      hasStar = true;
    } else if (t.startsWith("-")) {
      negatives.push(t.slice(1));
    } else {
      positives.push(t);
    }
  }

  // 校验：未知工具名 warn 跳过（不影响其它）
  for (const p of positives) {
    if (!allNames.has(p)) {
      log.warn("agent tool whitelist: unknown tool", { name: p });
    }
  }
  for (const n of negatives) {
    if (!allNames.has(n)) {
      log.warn("agent tool blacklist: unknown tool", { name: n });
    }
  }

  // 含负项 → 全集减法模式（即便用户没写 "*"）
  // 同时含正项 + 负项时也按减法处理，并 warn 提示语义混合
  if (negatives.length > 0) {
    if (positives.length > 0) {
      log.warn(
        "agent tools: mixing positive and negative entries; treating as full-set subtraction",
        { positives, negatives },
      );
    }
    const denied = new Set(negatives);
    return specs.filter((s) => !denied.has(s.function.name));
  }

  // 只有 "*"（无负项无正项）→ 全集
  if (hasStar && positives.length === 0) return [...specs];

  // 只有正项 → 严格白名单
  const allowed = new Set(positives);
  // "*" 与正项并存：意为全集 ∪ 正项 —— 等同全集
  if (hasStar) return [...specs];
  return specs.filter((s) => allowed.has(s.function.name));
}

/**
 * agent 是否允许暴露 MCP 工具给 LLM。默认 true（不限制）。
 *
 * 注意：此处仅过滤"暴露给 LLM 的 toolSpecs"。MCP 子进程的 acquire/release
 * 仍按 cwd 共享池逻辑做（mcp-lifecycle.ts），未受影响 —— agent 切换时不会
 * 触发 MCP 进程重启。
 */
export function agentAllowsMcp(agent: AgentTemplate | undefined): boolean {
  if (!agent) return true;
  return agent.mcp !== false;
}
