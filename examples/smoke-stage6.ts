// Stage-6 acceptance harness — exercises the upgraded read/edit/write
// pipeline end-to-end:
//
//   1. Read before Edit:  Edit must succeed.
//   2. Read twice in one prompt: second call should be a cache hit
//      (we observe the agent's stderr "cache hit" log).
//   3. Read with offset/limit: returned text uses correct line numbers.
//   4. Edit auto-reads unread file and succeeds.
//   5. Edit on a fresh file succeeds (auto-read).
//   6. Non-unique old_string rejected unless replace_all.
//   7. replace_all bypasses uniqueness check.
//   8. Write seeds cache so subsequent Edit works.
//
// Drives the agent directly via a custom ACP Client that mocks the
// fs/read_text_file and fs/write_text_file methods against a temp dir.
// Uses INVOX_MOCK=tools so the LLM is deterministic? No — MockToolProvider
// only emits Read. So this harness drives the agent's tools through
// a CUSTOM mock provider that emits a scripted sequence of tool_calls.
// We export it via INVOX_MOCK_SCRIPT (see below) — if that's awkward, we
// fall back to invoking the tools' execute() directly.
//
// To keep this simple and ship-fast, this harness invokes the tool
// registry directly from Node, NOT through a spawned invox subprocess.
// That covers: registry discovery, cache, gate, error messages.
// (Full subprocess + protocol coverage is already done by the other
// smokes; this one is laser-focused on tool semantics.)

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../src/tools/cache.js";
import { executeTool } from "../src/tools/router.js";
import type { ToolExecContext } from "../src/tools/types.js";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "invox-stage6-"));
  console.error("[stage6] temp dir:", dir);

  // Seed a file
  const file = join(dir, "hello.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\ndelta\nepsilon\n", "utf8");

  // Mock ACP connection: fs/read and fs/write hit the local disk inside `dir`.
  const conn = {
    async readTextFile(params: {
      path: string;
      line?: number | null;
      limit?: number | null;
    }) {
      const content = readFileSync(params.path, "utf8");
      // We deliberately ignore line/limit here — Read does its own
      // pagination using the cached full content, so the ACP server-side
      // slicing isn't on the hot path for this test.
      return { content };
    },
    async writeTextFile(params: { path: string; content: string }) {
      writeFileSync(params.path, params.content, "utf8");
      return {};
    },
    // Stubs for the rest of the AgentSideConnection interface, never invoked.
    async sessionUpdate() {},
    async requestPermission() {
      throw new Error("not used in stage6 smoke");
    },
    async createTerminal() {
      throw new Error("not used in stage6 smoke");
    },
  } as never;

  const state = {
    readPaths: new Set<string>(),
    cache: new FileCache(),
  };

  const ctx: ToolExecContext = {
    conn,
    sessionId: "s1",
    cwd: dir,
    caps: { fs: { readTextFile: true, writeTextFile: true } },
    signal: new AbortController().signal,
    policy: "never",
    toolCallId: "tc1",
    state,
  };

  // ── 1. Read produces line-numbered output and caches.
  let r = await executeTool(
    "Read",
    { path: "hello.txt", description: "read file" },
    ctx,
  );
  assert(r.ok, `1. Read should succeed: ${r.resultText}`);
  assert(
    /^\s*1\talpha/m.test(r.resultText),
    `1. expected line-numbered alpha: ${r.resultText}`,
  );
  assert(
    /^\s*5\tepsilon/m.test(r.resultText),
    `1. expected line 5 epsilon: ${r.resultText}`,
  );
  console.error("[stage6] ✓ Read numbers lines");

  // ── 2. cache hit: second Read uses cache (entries should be 1 still).
  const beforeMisses = state.cache.stats().misses;
  r = await executeTool(
    "Read",
    { path: "hello.txt", description: "read again" },
    ctx,
  );
  assert(r.ok, `2. second Read should succeed`);
  const afterMisses = state.cache.stats().misses;
  assert(
    afterMisses === beforeMisses,
    `2. expected cache hit (no new misses), but misses went ${beforeMisses}→${afterMisses}`,
  );
  console.error("[stage6] ✓ Read second call hits cache");

  // ── 3. Read with offset+limit returns correct line numbers.
  r = await executeTool(
    "Read",
    {
      path: "hello.txt",
      offset: 3,
      limit: 2,
      description: "page",
    },
    ctx,
  );
  assert(r.ok, `3. paginated read should succeed`);
  assert(
    /^\s*3\tgamma/m.test(r.resultText),
    `3. line 3 gamma missing: ${r.resultText}`,
  );
  assert(
    /^\s*4\tdelta/m.test(r.resultText),
    `3. line 4 delta missing: ${r.resultText}`,
  );
  assert(
    !/epsilon/.test(r.resultText),
    `3. line 5 should not be in slice: ${r.resultText}`,
  );
  console.error("[stage6] ✓ Read offset/limit paginates correctly");

  // ── 4. Edit auto-reads unread file and succeeds.
  const file2 = join(dir, "untouched.txt");
  writeFileSync(file2, "x\ny\nz\n", "utf8");
  r = await executeTool(
    "Edit",
    {
      path: "untouched.txt",
      old_string: "x",
      new_string: "X",
      description: "edit unread",
    },
    ctx,
  );
  assert(
    r.ok,
    `4. edit on unread file should auto-read and succeed: ${r.resultText}`,
  );
  console.error("[stage6] ✓ Edit auto-reads before editing");

  // ── 5. Edit on a fresh file succeeds (auto-read).
  writeFileSync(file2, "hello\nworld\n", "utf8");
  state.cache.invalidate(join(dir, "untouched.txt"));
  r = await executeTool(
    "Edit",
    {
      path: "untouched.txt",
      old_string: "hello",
      new_string: "HELLO",
      description: "replace hello",
    },
    ctx,
  );
  assert(r.ok, `5. edit should succeed: ${r.resultText}`);
  const onDisk = readFileSync(file2, "utf8");
  assert(
    onDisk === "HELLO\nworld\n",
    `5. expected HELLO, got: ${JSON.stringify(onDisk)}`,
  );
  console.error("[stage6] ✓ Edit applies precise replacement");

  // ── 6. Non-unique old_string should be rejected unless replace_all.
  writeFileSync(file2, "a\na\na\n", "utf8");
  state.cache.invalidate(join(dir, "untouched.txt"));
  r = await executeTool(
    "Edit",
    {
      path: "untouched.txt",
      old_string: "a",
      new_string: "A",
      description: "unique fail",
    },
    ctx,
  );
  assert(!r.ok, `6. non-unique edit should fail`);
  assert(
    /not unique/.test(r.resultText),
    `6. expected uniqueness error: ${r.resultText}`,
  );
  console.error("[stage6] ✓ Edit rejects non-unique old_string");

  // ── 7. replace_all bypasses uniqueness check.
  r = await executeTool(
    "Edit",
    {
      path: "untouched.txt",
      old_string: "a",
      new_string: "A",
      replace_all: true,
      description: "all",
    },
    ctx,
  );
  assert(r.ok, `7. replace_all should succeed: ${r.resultText}`);
  const after7 = readFileSync(file2, "utf8");
  assert(
    after7 === "A\nA\nA\n",
    `7. expected all replaced, got: ${JSON.stringify(after7)}`,
  );
  console.error("[stage6] ✓ Edit replace_all replaces every occurrence");

  // ── 8. Write seeds cache so subsequent Edit doesn't need Read.
  // (Fresh state to be sure.)
  const fresh = {
    readPaths: new Set<string>(),
    cache: new FileCache(),
  };
  const ctx2: ToolExecContext = { ...ctx, state: fresh };
  const file3 = join(dir, "new.txt");
  let r2 = await executeTool(
    "Write",
    {
      path: "new.txt",
      content: "one\ntwo\n",
      description: "create new",
    },
    ctx2,
  );
  assert(r2.ok, `8a. Write should succeed`);
  r2 = await executeTool(
    "Edit",
    {
      path: "new.txt",
      old_string: "one",
      new_string: "ONE",
      description: "edit just-written file",
    },
    ctx2,
  );
  assert(
    r2.ok,
    `8b. edit on just-written file should succeed: ${r2.resultText}`,
  );
  console.error("[stage6] ✓ Write seeds cache so subsequent Edit works");

  // ── 9. MakePlan 只能把方案写到 .invox/plans/<theme>.md。
  const planContent = "# Demo Plan\n\n## Goal\nSave a plan.\n";
  r2 = await executeTool(
    "MakePlan",
    {
      theme: "demo-plan",
      content: planContent,
      description: "save plan",
    },
    ctx2,
  );
  assert(r2.ok, `9a. MakePlan should succeed: ${r2.resultText}`);
  const planPath = join(dir, ".invox", "plans", "demo-plan.md");
  assert(
    readFileSync(planPath, "utf8") === planContent,
    "9a. MakePlan should write the expected markdown file",
  );
  r2 = await executeTool(
    "MakePlan",
    {
      theme: "../escape",
      content: planContent,
      description: "reject path traversal",
    },
    ctx2,
  );
  assert(!r2.ok, `9b. MakePlan should reject path-like themes`);
  console.error("[stage6] ✓ MakePlan writes only under .invox/plans");

  // Cleanup.
  rmSync(dir, { recursive: true, force: true });

  console.error("[stage6] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[stage6] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[stage6] uncaught:", err);
  process.exit(1);
});
