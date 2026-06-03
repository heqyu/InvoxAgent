// Skill: invoke reusable prompt templates / workflow definitions.
//
// Skills are named markdown/text templates that guide the agent through
// structured tasks (code review, explanation, test generation, etc.).
// When the LLM calls Skill("skill-name", params), the tool:
//
//   1. Looks up the skill definition by id
//   2. Interpolates $ARGUMENTS and {{param}} placeholders
//   3. Returns the rendered content as tool output
//
// The LLM then follows the rendered instructions using its existing tools
// (Read, Write, Edit, Bash, etc.).
//
// Skill definitions are loaded from three sources (lowest → highest priority):
//
//   1. ~/.claude/skills/<name>/SKILL.md          — user-level (global)
//   2. Plugin skills (from .plugins-cache.json)   — plugin-level
//   3. <cwd>/.claude/skills/<name>/SKILL.md       — project-level
//
// Higher-priority sources override lower ones on name collision.
// Calling Skill("list") or an unknown skill name returns the catalog.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";
import { loadPluginSkills } from "../plugins/loader.js";
import type { ToolSpec } from "../llm/types.js";
import { DESCRIPTION_FIELD } from "./shared.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

// ── Skill definition shape ──────────────────────────────────────────

interface SkillDef {
  /** Unique stable id — the subdirectory name under .claude/skills/. */
  id: string;
  /** The skill's prompt template content (from SKILL.md). */
  content: string;
  /** Source file path to SKILL.md (for logging / catalog). */
  source: string;
  /** Absolute path to the skill directory (dirname of source). */
  skillDir: string;
  /** Absolute path to the plugin root (for plugin skills only). */
  pluginRoot?: string;
  /** If loaded from a plugin, the plugin name. Undefined for direct skills. */
  pluginName?: string;
}

// ── Skill loading from .claude/skills/*/SKILL.md ────────────────────

const SKILL_FILE = "SKILL.md";

/**
 * Scan `<skillsDir>/<name>/SKILL.md` for each subdirectory.
 * Each valid subdirectory becomes a skill.
 */
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
        // SKILL.md missing or unreadable — skip silently
      }
    }
  } catch {
    // skillsDir doesn't exist — normal, not an error
  }
  return count;
}

/**
 * Load skills from .claude/skills/ directories. Cached by cwd so
 * repeated calls within the same session skip re-scanning.
 */
const cache = new Map<string, Map<string, SkillDef>>();

function loadSkills(cwd: string): Map<string, SkillDef> {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const skills = new Map<string, SkillDef>();

  // 1. User-level: ~/.claude/skills/<name>/SKILL.md (lowest priority)
  const globalDir = join(homedir(), ".claude", "skills");
  const globalCount = loadFromDir(globalDir, skills);

  // 2. Plugin-level: skills from enabled plugins in .plugins-cache.json
  //    (overrides user-level, but overridden by project-level)
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

  // 3. Project-level: <cwd>/.claude/skills/<name>/SKILL.md (highest priority)
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

// ── Template interpolation ──────────────────────────────────────────

/**
 * Interpolate placeholders in a skill template.
 *
 * Supports three styles:
 *   - `${CLAUDE_SKILL_DIR}` — replaced by the skill's directory path
 *                              (Windows-normalized to forward slashes)
 *   - `$ARGUMENTS`           — Claude Code compat: replaced by params.arguments
 *                              (string) or the full params JSON if not present.
 *   - `{{key}}`              — named params: replaced by params[key].
 *
 * Unresolved `{{key}}` placeholders are left as-is (forward-compat).
 */
function interpolate(
  template: string,
  params: Record<string, unknown>,
  skillDir?: string,
  pluginRoot?: string,
): string {
  let result = template;

  // 1. ${CLAUDE_SKILL_DIR} — skill's own directory for script resolution
  if (skillDir) {
    const normalized =
      process.platform === "win32" ? skillDir.replace(/\\/g, "/") : skillDir;
    result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalized);
  }

  // 2. ${CLAUDE_PLUGIN_ROOT} — plugin root directory (cross-skill / shared assets)
  if (pluginRoot) {
    const normalized =
      process.platform === "win32"
        ? pluginRoot.replace(/\\/g, "/")
        : pluginRoot;
    result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, normalized);
  }

  // 3. $ARGUMENTS — Claude Code convention
  const argsValue =
    typeof params["arguments"] === "string"
      ? params["arguments"]
      : Object.keys(params).length > 0
        ? JSON.stringify(params)
        : "";
  result = result.replace(/\$ARGUMENTS/g, argsValue);

  // 3. {{key}} — named params
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = params[key];
    if (val === undefined || val === null) return `{{${key}}}`;
    return String(val);
  });

  return result;
}

// ── YAML frontmatter parsing ───────────────────────────────────────

/**
 * Minimal YAML frontmatter parser — extracts scalar string values only.
 * Handles both plain scalars and YAML block scalars (>-, |-).
 *
 * Example input:
 *   ---
 *   name: my-skill
 *   description: >-
 *     This is a multi-line
 *     description.
 *   ---
 *
 * Returns `{ name: "my-skill", description: "This is a multi-line description." }`
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  // Strip UTF-8 BOM if present
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
    // New key-value pair (indented 0)
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      // Flush previous key
      if (currentKey) {
        result[currentKey] = currentValue.trim();
      }
      currentKey = kvMatch[1]!;
      const rawVal = kvMatch[2]!.trim();

      // Check for block scalar indicator
      if (rawVal === ">-" || rawVal === "|-") {
        blockScalar = rawVal as ">-" | "|-";
        currentValue = "";
      } else if (rawVal === ">" || rawVal === "|") {
        // Also handle > and | without dash (folded/literal)
        blockScalar = rawVal === ">" ? ">-" : "|-";
        currentValue = "";
      } else {
        blockScalar = "";
        // Strip surrounding quotes
        currentValue = rawVal.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Continuation of block scalar (indented)
    if (currentKey && blockScalar) {
      if (currentValue) currentValue += " ";
      currentValue += line.trim();
    }
  }

  // Flush last key
  if (currentKey) {
    result[currentKey] = currentValue.trim();
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract a human-readable description from a SKILL.md content.
 *
 * Priority:
 *   1. YAML frontmatter `description` field (best quality — author-written)
 *   2. First non-empty, non-frontmatter line of the markdown body
 *   3. Fallback: "Invoke the <id> skill"
 */
function extractDescription(content: string, id: string): string {
  // Try frontmatter first
  const fm = parseFrontmatter(content);
  if (fm?.["description"]) {
    let desc = fm["description"];
    // Unwrap YAML quoted strings if present
    desc = desc.replace(/^["']|["']$/g, "");
    if (desc.length > 200) desc = desc.slice(0, 197) + "…";
    return desc;
  }

  // Fall back: find first real line after frontmatter
  // Strip BOM if present
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
    // Skip empty lines, headings, frontmatter delimiters, horizontal rules
    if (
      !trimmed ||
      trimmed === "---" ||
      trimmed === "---" ||
      trimmed.startsWith("```")
    )
      continue;
    const desc = trimmed.length > 200 ? trimmed.slice(0, 197) + "…" : trimmed;
    return desc;
  }

  return `Invoke the ${id} skill`;
}

// ── ACP AvailableCommand export ─────────────────────────────────────

/**
 * ACP `AvailableCommand` shape — matches the protocol schema so the agent
 * can send `available_commands_update` and Zed renders a `/` command menu.
 */
export interface SkillAvailableCommand {
  name: string;
  description: string;
  input?: { type: "unstructured"; hint: string } | null;
}

/**
 * Build the ACP `AvailableCommand[]` array from the loaded skills.
 * Called by the agent after session creation/load so Zed's `/` menu is
 * populated with the project's skills.
 *
 * Each skill becomes a command:
 *   - `name`: the skill id (directory name)
 *   - `description`: extracted from SKILL.md frontmatter `description` field,
 *     or the first meaningful line of the markdown body (truncated to 200 chars)
 *   - `input`: unstructured with a hint showing the user can type args
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
 * Look up a skill by name and return its rendered content (with params
 * interpolated), or `null` if the skill doesn't exist.
 *
 * Used by the agent to intercept `/command args` in user prompts and
 * auto-invoke the skill without waiting for the LLM.
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

// ── Catalog rendering ───────────────────────────────────────────────

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
        description: DESCRIPTION_FIELD,
      },
      required: ["name", "description"],
    },
  },
};

// ── Execute ─────────────────────────────────────────────────────────

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const name = String(args["name"] ?? "").trim();
  if (!name) return errorResult("missing 'name'", "other", "Skill");

  const skills = loadSkills(ctx.cwd);

  // Special: "list" returns the catalog
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

  // Extract params (default to empty object)
  const params =
    typeof args["params"] === "object" && args["params"] !== null
      ? (args["params"] as Record<string, unknown>)
      : {};

  // Interpolate the skill's content template
  let rendered = interpolate(
    skill.content,
    params,
    skill.skillDir,
    skill.pluginRoot,
  );

  // Prepend base directory header so the LLM always knows where the skill
  // lives (cc-haha compatibility). Scripts referenced as
  // `${CLAUDE_SKILL_DIR}/scripts/foo.sh` will resolve correctly.
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

// ── Export ──────────────────────────────────────────────────────────

export const skillTool: Tool = {
  name: "Skill",
  tier: "read",
  spec,
  execute,
};
