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
// Skill definitions are loaded from .claude/skills/ directories:
//
//   1. <cwd>/.claude/skills/<name>/SKILL.md   — project-level
//   2. ~/.claude/skills/<name>/SKILL.md       — user-level (global)
//
// Project-level skills override user-level on name collision.
// Calling Skill("list") or an unknown skill name returns the catalog.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
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
  /** Source file path (for logging / catalog). */
  source: string;
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
        skills.set(id, { id, content, source: skillFile });
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

  // 1. User-level: ~/.claude/skills/<name>/SKILL.md
  const globalDir = join(homedir(), ".claude", "skills");
  const globalCount = loadFromDir(globalDir, skills);

  // 2. Project-level: <cwd>/.claude/skills/<name>/SKILL.md (overrides global)
  const projectDir = join(cwd, ".claude", "skills");
  const projectCount = loadFromDir(projectDir, skills);

  log.info("Skill: loaded", {
    cwd,
    globalDir,
    globalCount,
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
 * Supports two styles:
 *   - `$ARGUMENTS`           — Claude Code compat: replaced by params.arguments
 *                              (string) or the full params JSON if not present.
 *   - `{{key}}`              — named params: replaced by params[key].
 *
 * Unresolved `{{key}}` placeholders are left as-is (forward-compat).
 */
function interpolate(
  template: string,
  params: Record<string, unknown>,
): string {
  // 1. $ARGUMENTS — Claude Code convention
  const argsValue =
    typeof params["arguments"] === "string"
      ? params["arguments"]
      : Object.keys(params).length > 0
        ? JSON.stringify(params)
        : "";
  let result = template.replace(/\$ARGUMENTS/g, argsValue);

  // 2. {{key}} — named params
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = params[key];
    if (val === undefined || val === null) return `{{${key}}}`;
    return String(val);
  });

  return result;
}

// ── Catalog rendering ───────────────────────────────────────────────

function renderCatalog(skills: Map<string, SkillDef>): string {
  if (skills.size === 0) {
    return (
      "No skills found. Create a skill directory with a SKILL.md file:\n\n" +
      "  <project>/.claude/skills/<name>/SKILL.md   (project-level)\n" +
      "  ~/.claude/skills/<name>/SKILL.md           (user-level)\n\n" +
      "Use $ARGUMENTS for a catch-all param, or {{param_name}} for named params."
    );
  }
  const lines: string[] = ["Available skills:\n"];
  const sorted = [...skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of sorted) {
    const firstLine = skill.content.split("\n")[0]?.trim() ?? "";
    const desc =
      firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
    lines.push(`- **${skill.id}**${desc ? ` — ${desc}` : ""}`);
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
      "Invoke a reusable skill/workflow template loaded from .claude/skills/. " +
      "Each skill lives at .claude/skills/<name>/SKILL.md. Returns the " +
      "skill's rendered instructions for the current context.\n\n" +
      "Call Skill with name='list' to see all available skills.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The skill id to invoke (= directory name under .claude/skills/). " +
            'Use name="list" to list all available skills.',
        },
        params: {
          type: "object",
          description:
            "Parameters passed to the skill template. $ARGUMENTS is replaced " +
            "by params.arguments (or the full params JSON). {{key}} is replaced " +
            "by params[key].",
          additionalProperties: true,
        },
        description: {
          type: "string",
          description:
            "A short human-readable phrase describing what this call is doing, " +
            "in the same language the user is using. Shown as the title of the " +
            "tool call card in the user's editor.",
        },
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
  const rendered = interpolate(skill.content, params);

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
    title: name,
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
