// Skill 工具：调用可复用的 prompt 模板 / 工作流定义。
//
// Skill 是命名 Markdown 模板，引导 agent 走结构化任务（review、解释、
// 生成测试等）。LLM 调用 Skill("name", params) 时，工具：
//   1. 按 id 查找 skill
//   2. 插值 $ARGUMENTS / {{param}} / ${CLAUDE_SKILL_DIR} 等占位符
//   3. 把渲染后的内容作为 tool 输出返回
// LLM 接下来用既有工具（Read / Write / Edit / Bash …）执行渲染出的指令。
//
// Skill 加载源（低 → 高优先级）：
//   1. ~/.claude/skills/<name>/SKILL.md          —— 用户级（全局）
//   2. plugin skills（来自 .plugins-cache.json） —— plugin 级
//   3. <cwd>/.claude/skills/<name>/SKILL.md      —— 项目级
// 同名时高优先级覆盖低优先级。
// 调用 Skill("list") 或未知 skill 名都返回目录。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../log.js";
const log = createLogger("tools");
import { loadPluginSkills } from "../plugins/loader.js";
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

// ── Skill 定义 ──────────────────────────────────────────────────────

interface SkillDef {
  /** 唯一稳定 id —— .claude/skills/ 下的子目录名。 */
  id: string;
  /** SKILL.md 模板内容。 */
  content: string;
  /** SKILL.md 源文件路径（日志 / 目录展示用）。 */
  source: string;
  /** skill 目录的绝对路径（source 的 dirname）。 */
  skillDir: string;
  /** 仅 plugin skill：插件根目录绝对路径。 */
  pluginRoot?: string;
  /** 仅 plugin skill：插件名。 */
  pluginName?: string;
}

// ── 加载：从 .claude/skills/*/SKILL.md ──────────────────────────────

const SKILL_FILE = "SKILL.md";

/** 扫描 `<skillsDir>/<name>/SKILL.md`：每个有效子目录算一个 skill。 */
function loadFromDir(skillsDir: string, skills: Map<string, SkillDef>): number {
  let count = 0;
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!id) continue;
      const skillFile = join(skillsDir, id, SKILL_FILE);
      try {
        const content = readFileSync(skillFile, "utf8");
        if (!content.trim()) continue;
        skills.set(id, {
          id,
          content,
          source: skillFile,
          skillDir: join(skillsDir, id),
        });
        count++;
      } catch {
        // SKILL.md 缺失 / 不可读 —— 静默跳过
      }
    }
  } catch {
    // skillsDir 不存在 —— 正常情况，不算错误
  }
  return count;
}

/** 加载 .claude/skills/ 各级目录的 skill；按 cwd 缓存。 */
const cache = new Map<string, Map<string, SkillDef>>();

function loadSkills(cwd: string): Map<string, SkillDef> {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const skills = new Map<string, SkillDef>();

  // 1. 用户级（最低优先级）
  const globalDir = join(homedir(), ".claude", "skills");
  const globalCount = loadFromDir(globalDir, skills);

  // 2. plugin 级（覆盖用户级，但被项目级覆盖）
  const pluginSkills = loadPluginSkills(cwd);
  let pluginCount = 0;
  for (const [id, ps] of pluginSkills) {
    skills.set(id, {
      id: ps.id,
      content: ps.content,
      source: ps.source,
      skillDir: join(ps.source, ".."),
      pluginRoot: ps.pluginRoot,
      pluginName: ps.pluginName,
    });
    pluginCount++;
  }

  // 3. 项目级（最高优先级）
  const projectDir = join(cwd, ".claude", "skills");
  const projectCount = loadFromDir(projectDir, skills);

  log.info("Skill: loaded", {
    cwd,
    globalDir,
    globalCount,
    pluginCount,
    projectDir,
    projectCount,
    total: skills.size,
  });

  cache.set(cwd, skills);
  return skills;
}

// ── 模板插值 ────────────────────────────────────────────────────────

/**
 * 渲染 skill 模板，支持三类占位符：
 *   - `${CLAUDE_SKILL_DIR}` —— 该 skill 自身目录（Windows 下转为正斜杠）
 *   - `${CLAUDE_PLUGIN_ROOT}` —— 插件根目录（跨 skill 的共享资源）
 *   - `$ARGUMENTS`           —— 兼容 Claude Code：替换为 params.arguments，
 *                                若不存在则替换为 params 的 JSON 字符串
 *   - `{{key}}`              —— 命名参数：替换为 params[key]
 *
 * 未匹配的 `{{key}}` 原样保留（forward-compat）。
 */
function interpolate(
  template: string,
  params: Record<string, unknown>,
  skillDir?: string,
  pluginRoot?: string,
): string {
  let result = template;

  // 1. ${CLAUDE_SKILL_DIR}
  if (skillDir) {
    const normalized =
      process.platform === "win32" ? skillDir.replace(/\\/g, "/") : skillDir;
    result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalized);
  }

  // 2. ${CLAUDE_PLUGIN_ROOT}
  if (pluginRoot) {
    const normalized =
      process.platform === "win32"
        ? pluginRoot.replace(/\\/g, "/")
        : pluginRoot;
    result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, normalized);
  }

  // 3. $ARGUMENTS
  const argsValue =
    typeof params["arguments"] === "string"
      ? params["arguments"]
      : Object.keys(params).length > 0
        ? JSON.stringify(params)
        : "";
  result = result.replace(/\$ARGUMENTS/g, argsValue);

  // 4. {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = params[key];
    if (val === undefined || val === null) return `{{${key}}}`;
    return String(val);
  });

  return result;
}

// ── YAML frontmatter 解析（极简） ───────────────────────────────────

/**
 * 极简 YAML frontmatter 解析器，仅抽 string 值。
 * 支持纯 scalar 和 block scalar（>- / |- / > / |）。
 *
 * 例：
 *   ---
 *   name: my-skill
 *   description: >-
 *     This is a multi-line
 *     description.
 *   ---
 * 输出：{ name: "my-skill", description: "This is a multi-line description." }
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  // 去掉 BOM
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;
  const raw = content.slice(3, endIdx).trim();
  if (!raw) return null;

  const result: Record<string, string> = {};
  const lines = raw.split("\n");
  let currentKey = "";
  let currentValue = "";
  let blockScalar: "" | ">-" | "|-" = "";

  for (const line of lines) {
    // 新的 key-value（顶格）
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      // flush 上一个 key
      if (currentKey) {
        result[currentKey] = currentValue.trim();
      }
      currentKey = kvMatch[1]!;
      const rawVal = kvMatch[2]!.trim();

      // block scalar 标记
      if (rawVal === ">-" || rawVal === "|-") {
        blockScalar = rawVal as ">-" | "|-";
        currentValue = "";
      } else if (rawVal === ">" || rawVal === "|") {
        // 兼容不带 dash 的 folded / literal
        blockScalar = rawVal === ">" ? ">-" : "|-";
        currentValue = "";
      } else {
        blockScalar = "";
        // 去掉外层引号
        currentValue = rawVal.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // block scalar 续行（缩进）
    if (currentKey && blockScalar) {
      if (currentValue) currentValue += " ";
      currentValue += line.trim();
    }
  }

  // flush 最后一个 key
  if (currentKey) {
    result[currentKey] = currentValue.trim();
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 从 SKILL.md 抽出可读描述。优先级：
 *   1. YAML frontmatter 的 description 字段（作者写的，质量最高）
 *   2. frontmatter 之后的第一行非空、非标题、非分隔
 *   3. 兜底："Invoke the <id> skill"
 */
function extractDescription(content: string, id: string): string {
  // 先试 frontmatter
  const fm = parseFrontmatter(content);
  if (fm?.["description"]) {
    let desc = fm["description"];
    desc = desc.replace(/^["']|["']$/g, "");
    if (desc.length > 200) desc = desc.slice(0, 197) + "…";
    return desc;
  }

  // 退回正文第一行有效内容
  let raw = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let lines = raw.split("\n");
  if (lines[0]?.trim() === "---") {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const afterFm = raw.slice(endIdx + 4);
      lines = afterFm.split("\n");
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行、frontmatter 分隔、code fence
    if (!trimmed || trimmed === "---" || trimmed.startsWith("```")) continue;
    const desc = trimmed.length > 200 ? trimmed.slice(0, 197) + "…" : trimmed;
    return desc;
  }

  return `Invoke the ${id} skill`;
}

// ── ACP AvailableCommand 导出 ───────────────────────────────────────

/** 与协议 schema 对齐的 AvailableCommand，让 agent 能发 available_commands_update。 */
export interface SkillAvailableCommand {
  name: string;
  description: string;
  input?: { type: "unstructured"; hint: string } | null;
}

/**
 * 把已加载的 skill 集合构造成 ACP `AvailableCommand[]`。
 * agent 在 newSession / loadSession 后调用一次，让 Zed 的 `/` 命令菜单
 * 出现项目里的 skill。
 */
export function listAvailableCommands(cwd: string): SkillAvailableCommand[] {
  const skills = loadSkills(cwd);
  const commands: SkillAvailableCommand[] = [];

  for (const skill of [...skills.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const desc = extractDescription(skill.content, skill.id);
    commands.push({
      name: skill.id,
      description: desc,
      input: { type: "unstructured", hint: "Skill parameters (optional)" },
    });
  }

  return commands;
}

/**
 * 按名查 skill 并返回插值后内容。skill 不存在返回 null。
 * 用于 agent 拦截用户输入的 `/command args` 直接执行 skill，无需 LLM 介入。
 */
export function renderSkill(
  cwd: string,
  name: string,
  params: Record<string, unknown> = {},
): string | null {
  const skills = loadSkills(cwd);
  const skill = skills.get(name);
  if (!skill) return null;
  return interpolate(skill.content, params, skill.skillDir, skill.pluginRoot);
}

// ── 目录渲染 ────────────────────────────────────────────────────────

function renderCatalog(skills: Map<string, SkillDef>): string {
  if (skills.size === 0) {
    return (
      "No skills found. Create a skill directory with a SKILL.md file:\n\n" +
      "  <project>/.claude/skills/<name>/SKILL.md   (project-level)\n" +
      "  ~/.claude/skills/<name>/SKILL.md           (user-level)\n\n" +
      "Or install plugins with a .plugins-cache.json at the project root.\n\n" +
      "Use $ARGUMENTS for a catch-all param, or {{param_name}} for named params."
    );
  }
  const lines: string[] = ["Available skills:\n"];
  const sorted = [...skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of sorted) {
    const desc = extractDescription(skill.content, skill.id);
    const src = skill.pluginName ? ` [plugin: ${skill.pluginName}]` : "";
    lines.push(`- **${skill.id}**${desc ? ` — ${desc}` : ""}${src}`);
  }
  lines.push(`\nCall a skill with: Skill({ name: "<id>", params: { ... } })`);
  return lines.join("\n");
}

// ── Tool spec ───────────────────────────────────────────────────────

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Skill",
    description:
      "Execute a skill within the main conversation\n\n" +
      "When users ask you to perform tasks, check if any of the available skills match. " +
      "Skills provide specialized capabilities and domain knowledge.\n\n" +
      'When users reference a "slash command" or "/<something>", they are referring to a skill. ' +
      "Use this tool to invoke it.\n\n" +
      "How to invoke:\n" +
      "- Set `name` to the exact name of an available skill (no leading slash).\n" +
      "- Set `params` to pass optional arguments to the skill.\n\n" +
      "Important:\n" +
      "- Available skills are listed in the # Available Skills section of the system prompt.\n" +
      "- Only invoke a skill that appears in that list, or one the user explicitly typed as /<name> " +
      "in their message. Never guess or invent a skill name from training data; otherwise do not call this tool\n" +
      "- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: " +
      "invoke the relevant Skill tool BEFORE generating any other response about the task\n" +
      "- NEVER mention a skill without actually calling this tool\n" +
      "- Do not invoke a skill that is already running\n" +
      "- If the skill's instructions are already visible in the current conversation " +
      "(e.g. from a previous Skill call or /command), follow them directly " +
      "instead of calling this tool again\n",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The name of a skill from the available-skills list. Do not guess names.",
        },
        params: {
          type: "object",
          description:
            "Parameters passed to the skill template. $ARGUMENTS is replaced " +
            "by params.arguments (or the full params JSON). {{key}} is replaced " +
            "by params[key].",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
};

// ── execute ─────────────────────────────────────────────────────────

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const name = String(args["name"] ?? "").trim();
  if (!name) return errorResult("missing 'name'", "other", "Skill");

  const skills = loadSkills(ctx.cwd);

  // 特殊：name === "list" 返回目录
  if (name === "list") {
    const catalog = renderCatalog(skills);
    log.info("Skill: list", { count: skills.size, cwd: ctx.cwd });
    return {
      resultText: catalog,
      acpContent: [
        { type: "content", content: { type: "text", text: catalog } },
      ],
      kind: "read",
      title: "Skill catalog",
      ok: true,
    };
  }

  const skill = skills.get(name);
  if (!skill) {
    const catalog = renderCatalog(skills);
    const msg = `Unknown skill: "${name}".\n\n${catalog}`;
    log.warn("Skill: unknown skill", { name, cwd: ctx.cwd });
    return {
      resultText: msg,
      acpContent: [{ type: "content", content: { type: "text", text: msg } }],
      kind: "read",
      title: `Skill: ${name} (unknown)`,
      ok: false,
    };
  }

  // 取参数（默认空对象）
  const params =
    typeof args["params"] === "object" && args["params"] !== null
      ? (args["params"] as Record<string, unknown>)
      : {};

  // 插值模板
  let rendered = interpolate(
    skill.content,
    params,
    skill.skillDir,
    skill.pluginRoot,
  );

  // 在内容前面追加 base directory 头，让 LLM 始终知道 skill 所在目录
  // （cc-haha 兼容）。脚本写成 `${CLAUDE_SKILL_DIR}/scripts/foo.sh` 时
  // 也能被正确解析。
  const normalizedDir =
    process.platform === "win32"
      ? skill.skillDir.replace(/\\/g, "/")
      : skill.skillDir;
  rendered = `Base directory for this skill: ${normalizedDir}\n\n${rendered}`;

  log.info("Skill: invoked", {
    name,
    source: skill.source,
    paramKeys: Object.keys(params),
  });

  return {
    resultText: rendered,
    acpContent: [
      { type: "content", content: { type: "text", text: rendered } },
    ],
    kind: "read",
    title: `Skill (${name}) Loaded`,
    ok: true,
  };
}

export const skillTool: Tool = {
  name: "Skill",
  tier: "read",
  spec,
  execute,
};
