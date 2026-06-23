// Smoke test for the Skill tool — creates a temp .claude/skills/ directory
// with test SKILL.md files, then exercises the skill loading + invocation paths.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool } from "../src/tools/router.js";
import { FileCache } from "../src/tools/cache.js";
import { getTool, TOOL_SPECS } from "../src/tools/registry.js";
import type { ToolExecContext, SessionToolState } from "../src/tools/types.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

async function main(): Promise<void> {
  console.log("[smoke-skill] starting...\n");

  // ── Setup: create temp project with .claude/skills/ ───────────────
  const tmpDir = join(tmpdir(), `invox-skill-test-${Date.now()}`);
  const skillsDir = join(tmpDir, ".claude", "skills");

  // Skill: explain
  mkdirSync(join(skillsDir, "explain"), { recursive: true });
  writeFileSync(
    join(skillsDir, "explain", "SKILL.md"),
    "Explain the following code:\n\n```\n$ARGUMENTS\n```\n\nProvide overview and issues.",
    "utf8",
  );

  // Skill: review (uses {{param}})
  mkdirSync(join(skillsDir, "review"), { recursive: true });
  writeFileSync(
    join(skillsDir, "review", "SKILL.md"),
    "Review `{{path}}` for bugs.\n\nCheck: security, performance, correctness.",
    "utf8",
  );

  // Skill: commit-msg
  mkdirSync(join(skillsDir, "commit-msg"), { recursive: true });
  writeFileSync(
    join(skillsDir, "commit-msg", "SKILL.md"),
    "Generate a git commit message for:\n\n```diff\n$ARGUMENTS\n```\n\nUse conventional commits format.",
    "utf8",
  );

  // Empty SKILL.md — should be skipped
  mkdirSync(join(skillsDir, "empty"), { recursive: true });
  writeFileSync(join(skillsDir, "empty", "SKILL.md"), "   \n  ", "utf8");

  // Directory without SKILL.md — should be skipped
  mkdirSync(join(skillsDir, "no-file"), { recursive: true });

  try {
    // ── 1. Verify Skill is registered ──────────────────────────────
    const skillSpec = TOOL_SPECS.find((s) => s.function.name === "Skill");
    ASSERT(!!skillSpec, "Skill tool spec found in TOOL_SPECS");

    const skillTool = getTool("Skill");
    ASSERT(!!skillTool, "Skill tool found via getTool()");
    ASSERT(skillTool!.tier === "read", "Skill tier is 'read'");

    // ── 2. Build a minimal ToolExecContext with temp cwd ────────────
    const state: SessionToolState = {
      readPaths: new Set(),
      cache: new FileCache(),
    };
    const ctx: ToolExecContext = {
      conn: null as never,
      sessionId: "test-session",
      cwd: tmpDir,
      caps: {},
      signal: new AbortController().signal,
      policy: "never",
      toolCallId: "test-call",
      state,
    };

    // ── 3. Test Skill("list") ──────────────────────────────────────
    const listResult = await executeTool(
      "Skill",
      { name: "list", description: "List skills" },
      ctx,
    );
    ASSERT(listResult.ok, "Skill('list') succeeds");
    ASSERT(
      listResult.resultText.includes("explain"),
      "Skill('list') contains 'explain'",
    );
    ASSERT(
      listResult.resultText.includes("review"),
      "Skill('list') contains 'review'",
    );
    ASSERT(
      listResult.resultText.includes("commit-msg"),
      "Skill('list') contains 'commit-msg'",
    );
    ASSERT(
      !listResult.resultText.includes("**empty**"),
      "Skill('list') skips empty SKILL.md",
    );
    ASSERT(
      !listResult.resultText.includes("**no-file**"),
      "Skill('list') skips dirs without SKILL.md",
    );

    // ── 4. Test Skill("explain") with $ARGUMENTS ────────────────────
    const explainResult = await executeTool(
      "Skill",
      {
        name: "explain",
        description: "Explain some code",
        params: { arguments: "function add(a,b){return a+b}" },
      },
      ctx,
    );
    ASSERT(explainResult.ok, "Skill('explain') succeeds");
    ASSERT(
      explainResult.resultText.includes("function add(a,b){return a+b}"),
      "Skill('explain') replaces $ARGUMENTS with params.arguments",
    );
    ASSERT(
      explainResult.resultText.includes("Explain the following code"),
      "Skill('explain') contains template content",
    );

    // ── 5. Test Skill("explain") $ARGUMENTS fallback ────────────────
    const explainFallback = await executeTool(
      "Skill",
      {
        name: "explain",
        description: "Explain fallback",
        params: { code: "x = 1" },
      },
      ctx,
    );
    ASSERT(explainFallback.ok, "Skill('explain') with no .arguments succeeds");
    ASSERT(
      explainFallback.resultText.includes('"code":"x = 1"'),
      "Skill('explain') $ARGUMENTS falls back to JSON.stringify(params)",
    );

    // ── 6. Test Skill("review") with {{path}} ──────────────────────
    const reviewResult = await executeTool(
      "Skill",
      {
        name: "review",
        description: "Review a file",
        params: { path: "src/main.ts" },
      },
      ctx,
    );
    ASSERT(reviewResult.ok, "Skill('review') succeeds");
    ASSERT(
      reviewResult.resultText.includes("src/main.ts"),
      "Skill('review') replaces {{path}} with params.path",
    );
    ASSERT(
      reviewResult.resultText.includes("Review `src/main.ts` for bugs"),
      "Skill('review') interpolates into template",
    );

    // ── 7. Test Skill("commit-msg") ─────────────────────────────────
    const commitResult = await executeTool(
      "Skill",
      {
        name: "commit-msg",
        description: "Generate commit msg",
        params: { arguments: "+added new feature" },
      },
      ctx,
    );
    ASSERT(commitResult.ok, "Skill('commit-msg') succeeds");
    ASSERT(
      commitResult.resultText.includes("+added new feature"),
      "Skill('commit-msg') replaces $ARGUMENTS",
    );

    // ── 8. Test unknown skill ───────────────────────────────────────
    const unknownResult = await executeTool(
      "Skill",
      { name: "nonexistent", description: "Unknown" },
      ctx,
    );
    ASSERT(!unknownResult.ok, "Skill('nonexistent') returns ok=false");
    ASSERT(
      unknownResult.resultText.includes("Unknown skill"),
      "Unknown skill message present",
    );
    ASSERT(
      unknownResult.resultText.includes("explain"),
      "Unknown skill output includes catalog",
    );

    // ── 9. Test missing name ────────────────────────────────────────
    const noNameResult = await executeTool(
      "Skill",
      { description: "No name" },
      ctx,
    );
    ASSERT(!noNameResult.ok, "Skill() with no name returns ok=false");
    ASSERT(
      noNameResult.resultText.includes("missing 'name'"),
      "Missing name error message",
    );

    // ── 10. Test cwd with no project-level skills ───────────────────
    //    User-level skills from ~/.claude/skills/ may still be present.
    const emptyCtx: ToolExecContext = {
      ...ctx,
      cwd: tmpdir(),
    };
    const emptyResult = await executeTool(
      "Skill",
      { name: "list", description: "List" },
      emptyCtx,
    );
    ASSERT(emptyResult.ok, "Skill('list') in empty-project cwd succeeds");
    // The catalog is either "No skills found" (if no user-level skills)
    // or lists user-level skills — both are valid.
    ASSERT(
      emptyResult.resultText.includes("No skills found") ||
        emptyResult.resultText.includes("Available skills"),
      "Empty-project cwd shows catalog or 'No skills found'",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-skill] PASS");
}

main().catch((err) => {
  console.error("[smoke-skill] FATAL:", err);
  process.exit(1);
});
