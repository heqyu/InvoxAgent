// Smoke test for the CLAUDE.md static memory system.
//
// Creates temp user/project directories with CLAUDE.md files (including
// @references), verifies loading, resolution, source labels, and caching.
//
// Usage: npx tsx examples/smoke-claude-md.ts

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadClaudeMd,
  clearClaudeMdCache,
} from "../src/discovery/claude-md.js";
import { clearDiscoveryCache } from "../src/discovery/index.js";

const ASSERT = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

async function main(): Promise<void> {
  console.log("[smoke-claude-md] starting...\n");

  const tmpDir = join(tmpdir(), `invox-claudemd-${Date.now()}`);

  // ── Setup: fake HOME to isolate from real user settings ──────────
  const fakeHome = join(tmpDir, "fake-home");
  const fakeClaude = join(fakeHome, ".claude");
  mkdirSync(fakeClaude, { recursive: true });

  // User-level CLAUDE.md with @reference
  writeFileSync(
    join(fakeClaude, "RTK.md"),
    "# RTK Reference\nUse `rtk` for dev commands.",
    "utf8",
  );
  writeFileSync(
    join(fakeClaude, "CLAUDE.md"),
    "## User Preferences\n- Use python3\n- Windows 11\n\n@RTK.md",
    "utf8",
  );

  // Project-level .claude/ with CLAUDE.md
  const projectClaude = join(tmpDir, ".claude");
  mkdirSync(projectClaude, { recursive: true });
  writeFileSync(
    join(projectClaude, "CLAUDE.md"),
    "## Project Rules\n- Use conventional commits\n- Run tests before pushing",
    "utf8",
  );

  // Override HOME
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  try {
    clearClaudeMdCache();
    clearDiscoveryCache();

    // ── 1. Both levels loaded ─────────────────────────────────────
    console.log("── 1. Both levels loaded ──────────────────");
    const sections = loadClaudeMd(tmpDir);
    ASSERT(sections.length === 2, "Got 2 sections (user + project)");
    ASSERT(sections[0]!.source === "user", "First section is user");
    ASSERT(sections[1]!.source === "project", "Second section is project");

    // ── 2. User content includes @resolved reference ─────────────
    console.log("\n── 2. @reference resolution ───────────────");
    const userContent = sections[0]!.content;
    ASSERT(
      userContent.includes("User Preferences"),
      "User section has original content",
    );
    ASSERT(
      userContent.includes("RTK Reference"),
      "User section has resolved @RTK.md content",
    );
    ASSERT(userContent.includes("rtk"), "User section has RTK reference body");
    ASSERT(
      !userContent.includes("@RTK.md"),
      "User section no longer has raw @RTK.md",
    );

    // ── 3. Project content ───────────────────────────────────────
    console.log("\n── 3. Project content ────────────────────");
    const projectContent = sections[1]!.content;
    ASSERT(
      projectContent.includes("Project Rules"),
      "Project section has content",
    );
    ASSERT(
      projectContent.includes("conventional commits"),
      "Project section has project-specific rules",
    );

    // ── 4. Cache ─────────────────────────────────────────────────
    console.log("\n── 4. Cache ──────────────────────────────");
    const cached = loadClaudeMd(tmpDir);
    ASSERT(cached === sections, "loadClaudeMd returns cached result");
    clearClaudeMdCache(tmpDir);
    const fresh = loadClaudeMd(tmpDir);
    ASSERT(fresh !== sections, "clearClaudeMdCache invalidates");

    // ── 5. No CLAUDE.md ──────────────────────────────────────────
    //    Use a bare HOME (no CLAUDE.md) to test the empty case.
    console.log("\n── 5. No CLAUDE.md ──────────────────────");
    const bareHome = join(tmpDir, "bare-home");
    mkdirSync(bareHome, { recursive: true });
    process.env.HOME = bareHome;
    process.env.USERPROFILE = bareHome;
    const emptyDir = join(tmpdir(), `invox-claudemd-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      clearClaudeMdCache(emptyDir);
      clearDiscoveryCache(emptyDir);
      const empty = loadClaudeMd(emptyDir);
      ASSERT(empty.length === 0, "No sections when no CLAUDE.md files");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // Restore HOME to fakeHome with CLAUDE.md
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    // ── 6. Only user-level ───────────────────────────────────────
    console.log("\n── 6. Only user-level ────────────────────");
    const userOnlyDir = join(tmpdir(), `invox-claudemd-useronly-${Date.now()}`);
    mkdirSync(userOnlyDir, { recursive: true });
    try {
      clearClaudeMdCache(userOnlyDir);
      clearDiscoveryCache(userOnlyDir);
      const userOnly = loadClaudeMd(userOnlyDir);
      ASSERT(userOnly.length === 1, "1 section (user only)");
      ASSERT(userOnly[0]!.source === "user", "Section is user-level");
    } finally {
      rmSync(userOnlyDir, { recursive: true, force: true });
    }

    // ── 7. Broken @reference ─────────────────────────────────────
    //    Use bare HOME so only the project-level CLAUDE.md (with broken ref) is tested.
    console.log("\n── 7. Broken @reference ─────────────────");
    process.env.HOME = bareHome;
    process.env.USERPROFILE = bareHome;
    const brokenDir = join(tmpdir(), `invox-claudemd-broken-${Date.now()}`);
    const brokenClaude = join(brokenDir, ".claude");
    mkdirSync(brokenClaude, { recursive: true });
    writeFileSync(
      join(brokenClaude, "CLAUDE.md"),
      "Some text\n\n@nonexistent.md\n\nMore text",
      "utf8",
    );
    try {
      clearClaudeMdCache(brokenDir);
      clearDiscoveryCache(brokenDir);
      const broken = loadClaudeMd(brokenDir);
      ASSERT(broken.length === 1, "1 section despite broken reference");
      ASSERT(
        broken[0]!.content.includes("[file not found]"),
        "Broken reference shows [file not found]",
      );
      ASSERT(
        broken[0]!.content.includes("Some text"),
        "Other content preserved",
      );
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  } finally {
    clearClaudeMdCache();
    clearDiscoveryCache();
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined)
      process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n[smoke-claude-md] PASS");
}

main().catch((err) => {
  console.error("[smoke-claude-md] FATAL:", err);
  process.exit(1);
});
