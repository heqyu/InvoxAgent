// Stage 6.3 / 6.4 acceptance — Glob and Grep work end-to-end.
// Runs both tools directly against a temp directory tree.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../src/tools/cache.js";
import { executeTool } from "../src/tools/router.js";
import type { ToolExecContext } from "../src/tools/types.js";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "invox-stage6gg-"));
  console.error("[stage6gg] temp dir:", dir);

  // Build a fake project:
  //   src/
  //     a.ts        (contains "export class Foo")
  //     b.ts        (contains "import { Foo }")
  //   tests/
  //     a.test.ts   (contains "Foo")
  //   README.md
  //   node_modules/x/y.ts  (should be ignored)
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export class Foo {}\nexport const TAG = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "import { Foo } from './a.js';\nnew Foo();\n");
  writeFileSync(join(dir, "tests", "a.test.ts"), "import { Foo } from '../src/a.js';\nFoo;\n");
  writeFileSync(join(dir, "README.md"), "# project\nuse Foo carefully\n");
  writeFileSync(join(dir, "node_modules", "x", "y.ts"), "Foo\n");

  const conn = {} as never;
  const ctx: ToolExecContext = {
    conn,
    sessionId: "s",
    cwd: dir,
    caps: {},
    signal: new AbortController().signal,
    policy: "never",
    toolCallId: "tc",
    state: { readPaths: new Set(), cache: new FileCache() },
  };

  // ── 1. glob '**/*.ts' returns 3 ts files (excludes node_modules).
  let r = await executeTool(
    "glob",
    JSON.stringify({ pattern: "**/*.ts", description: "find ts" }),
    ctx,
  );
  assert(r.ok, `1. glob should succeed`);
  // Body lines = absolute paths. Distinguish from header lines like
  // "Pattern: **/*.ts" by requiring a Windows drive letter or POSIX root.
  const lines1 = r.resultText
    .split("\n")
    .filter((l) => l.match(/^([A-Za-z]:[\\/]|\/).+\.ts$/));
  assert(
    lines1.length === 3,
    `1. expected 3 .ts files, got ${lines1.length}: ${r.resultText}`,
  );
  assert(
    !r.resultText.includes("node_modules"),
    `1. node_modules should be ignored: ${r.resultText}`,
  );
  console.error("[stage6gg] ✓ glob returns 3 ts files, ignores node_modules");

  // ── 2. glob with explicit path narrows the search.
  r = await executeTool(
    "glob",
    JSON.stringify({ pattern: "**/*.ts", path: "tests", description: "find tests" }),
    ctx,
  );
  assert(r.ok, `2. scoped glob should succeed`);
  const lines2 = r.resultText
    .split("\n")
    .filter((l) => l.match(/^([A-Za-z]:[\\/]|\/).+\.ts$/));
  assert(lines2.length === 1, `2. expected 1 ts file under tests/, got ${lines2.length}`);
  assert(
    lines2[0]?.includes("a.test.ts"),
    `2. expected a.test.ts, got ${JSON.stringify(lines2[0])}`,
  );
  console.error("[stage6gg] ✓ glob honors explicit path");

  // ── 3. grep finds 'Foo' in 3 files (a.ts, b.ts, a.test.ts, README) — wait,
  //   README also has Foo. Let's expect 4 total file matches.
  r = await executeTool(
    "grep",
    JSON.stringify({
      pattern: "Foo",
      output_mode: "files_with_matches",
      description: "find Foo",
    }),
    ctx,
  );
  assert(r.ok, `3. grep -l should succeed`);
  // Body lines that look like absolute paths (skip header).
  const fileLines = r.resultText
    .split("\n")
    .filter((l) => l.match(/^([A-Za-z]:[\\/]|\/).+\.(ts|md)$/));
  assert(
    fileLines.length === 4,
    `3. expected Foo in 4 files (a.ts, b.ts, a.test.ts, README.md), got ${fileLines.length}: ${r.resultText}`,
  );
  console.error("[stage6gg] ✓ grep -l finds Foo in 4 files (excluding node_modules)");

  // ── 4. grep content mode shows lineno:text.
  r = await executeTool(
    "grep",
    JSON.stringify({
      pattern: "export class Foo",
      description: "find class def",
    }),
    ctx,
  );
  assert(r.ok, `4. grep content should succeed`);
  // ripgrep output: <path>:<line>:<text>
  const matchLine = r.resultText.split("\n").find((l) => /a\.ts:\d+:export class Foo/.test(l));
  assert(matchLine !== undefined, `4. expected 'a.ts:N:export class Foo' line: ${r.resultText}`);
  console.error("[stage6gg] ✓ grep content mode emits path:line:text");

  // ── 5. grep with case-insensitive picks up matches that differ only in case.
  writeFileSync(join(dir, "src", "case.ts"), "TODO: handle this\ntodo: another\n");
  r = await executeTool(
    "grep",
    JSON.stringify({
      pattern: "todo:",
      case_insensitive: true,
      output_mode: "count",
      description: "count TODOs",
    }),
    ctx,
  );
  assert(r.ok, `5. grep -i -c should succeed`);
  // Body should contain "case.ts:2" (file with 2 matches).
  const countLine = r.resultText.split("\n").find((l) => /case\.ts:2$/.test(l));
  assert(countLine !== undefined, `5. expected 'case.ts:2' count line: ${r.resultText}`);
  console.error("[stage6gg] ✓ grep --case-insensitive --count works");

  // ── 6. grep with glob filter constrains files searched.
  r = await executeTool(
    "grep",
    JSON.stringify({
      pattern: "Foo",
      glob: "*.md",
      output_mode: "files_with_matches",
      description: "find Foo in docs",
    }),
    ctx,
  );
  assert(r.ok, `6. grep with glob should succeed`);
  const mdMatches = r.resultText
    .split("\n")
    .filter((l) => l.match(/^([A-Za-z]:[\\/]|\/).+\.(ts|md)$/));
  assert(
    mdMatches.length === 1 && mdMatches[0]?.endsWith("README.md"),
    `6. expected only README.md, got: ${mdMatches.join("\n")}`,
  );
  console.error("[stage6gg] ✓ grep --glob restricts to file types");

  rmSync(dir, { recursive: true, force: true });
  console.error("[stage6gg] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[stage6gg] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[stage6gg] uncaught:", err);
  process.exit(1);
});
