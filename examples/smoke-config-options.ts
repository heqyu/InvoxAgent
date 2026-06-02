// Stage 9 acceptance harness — custom session-config dropdowns.
//
// Verifies that:
//   1. session/new advertises configOptions including system_prompt + thinking,
//      with currentValue=default-prompt-id and "off".
//   2. session/set_config_option { configId: "system_prompt", value: "review" }
//      a) succeeds
//      b) returns the refreshed full configOptions list
//      c) atomically replaces history[0] with the review template's prompt
//         (verified by reading the on-disk session JSON after persist())
//   3. session/set_config_option { configId: "thinking", value: "high" }
//      flips that option and persists it.
//   4. After process restart + session/load, configOptions.currentValue
//      reflects the last-written values (system_prompt=review, thinking=high).
//
// Exercises the standard ClientSideConnection from
// @agentclientprotocol/sdk@0.23 — setSessionConfigOption is a stable method
// and the SDK has a typed helper.
//
// Run: npx tsx examples/smoke-config-options.ts

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

interface SpawnedAgent {
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
}

function spawnAgent(sessionCwd: string): SpawnedAgent {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts"), "--stdio"],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "info",
        INVOX_MOCK: "tools",
        INVOX_SESSION_DIR: join(sessionCwd, ".invox", "sessions"),
        // Use the built-in 3-template menu — no INVOX_PROMPT_TEMPLATES_FILE.
      },
    },
  ) as ChildProcessWithoutNullStreams;
  child.on("error", (err) => {
    console.error("[smoke-config-options] spawn failed:", err);
    process.exit(1);
  });

  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const client: Client = {
    async sessionUpdate() {
      // Notifications are irrelevant for this test; drop them.
    },
    async requestPermission() {
      throw new Error("not used (policy: never ask)");
    },
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      return { content: readFileSync(params.path, "utf8") };
    },
  };
  const conn = new ClientSideConnection(() => client, stream);
  return { child, conn };
}

function findOption(
  options: SessionConfigOption[],
  id: string,
): SessionConfigOption {
  const match = options.find((o) => o.id === id);
  if (!match) {
    throw new Error(`config option ${id} missing from list: ${options.map((o) => o.id).join(", ")}`);
  }
  return match;
}

function currentValueOf(opt: SessionConfigOption): string {
  // SessionConfigOption is a discriminated union by `type`; both `select`
  // and `boolean` carry a `currentValue` (the latter as a bool).
  const v = (opt as { currentValue?: unknown }).currentValue;
  if (typeof v !== "string") {
    throw new Error(`expected string currentValue on ${opt.id}, got ${typeof v}: ${String(v)}`);
  }
  return v;
}

async function main(): Promise<void> {
  const workCwd = mkdtempSync(join(tmpdir(), "invox-smoke-config-"));
  console.error("[smoke-config-options] cwd:", workCwd);

  // ── First process: new session, flip both dropdowns ────────────────────
  const a = spawnAgent(workCwd);

  await a.conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  console.error("[smoke-config-options] ✓ initialize");

  const sess = await a.conn.newSession({ cwd: workCwd, mcpServers: [] });
  const initialOptions = (sess as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  assert(
    initialOptions.length >= 2,
    `expected ≥ 2 configOptions on session/new, got ${initialOptions.length}: ${initialOptions.map((o) => o.id).join(",")}`,
  );

  const initialPromptOpt = findOption(initialOptions, "system_prompt");
  assert(currentValueOf(initialPromptOpt) === "default",
    `initial system_prompt should be "default", got ${currentValueOf(initialPromptOpt)}`);

  const initialThinkOpt = findOption(initialOptions, "thinking");
  assert(currentValueOf(initialThinkOpt) === "off",
    `initial thinking should be "off", got ${currentValueOf(initialThinkOpt)}`);
  console.error("[smoke-config-options] ✓ session/new advertises", initialOptions.map((o) => o.id));

  // Switch system_prompt → review
  const setPrompt = await a.conn.setSessionConfigOption({
    sessionId: sess.sessionId,
    configId: "system_prompt",
    value: "review",
  });
  const afterPromptOpts = (setPrompt as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  assert(afterPromptOpts.length === initialOptions.length,
    `set_config_option response should return the FULL refreshed list (${initialOptions.length} opts), got ${afterPromptOpts.length}`);
  assert(currentValueOf(findOption(afterPromptOpts, "system_prompt")) === "review",
    `after set, system_prompt currentValue should be "review"`);
  console.error("[smoke-config-options] ✓ set_config_option(system_prompt=review)");

  // Switch thinking → high
  const setThink = await a.conn.setSessionConfigOption({
    sessionId: sess.sessionId,
    configId: "thinking",
    value: "high",
  });
  const afterThinkOpts = (setThink as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  assert(currentValueOf(findOption(afterThinkOpts, "thinking")) === "high",
    `after set, thinking currentValue should be "high"`);
  // system_prompt should still be "review" (state is preserved across sets)
  assert(currentValueOf(findOption(afterThinkOpts, "system_prompt")) === "review",
    `system_prompt should remain "review" after thinking set`);
  console.error("[smoke-config-options] ✓ set_config_option(thinking=high)");

  // Drive a prompt so MockToolProvider runs, persisting the session.
  writeFileSync(join(workCwd, "package.json"), '{"name":"smoke"}');
  const promptRes = await a.conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: 'please read "package.json"' }],
  });
  assert(promptRes.stopReason === "end_turn",
    `expected end_turn, got ${promptRes.stopReason}`);

  a.child.kill();
  await waitExit(a.child);

  // ── On-disk verification ───────────────────────────────────────────────
  const sessionsDir = join(workCwd, ".invox", "sessions");
  assert(existsSync(sessionsDir), `sessions dir not created: ${sessionsDir}`);
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  assert(files.length === 1, `expected 1 session file, got ${files.length}`);
  const snapshot = JSON.parse(readFileSync(join(sessionsDir, files[0]!), "utf8")) as {
    id: string;
    configValues?: Record<string, string>;
    history: { role: string; content: string }[];
  };
  assert(snapshot.configValues?.system_prompt === "review",
    `disk configValues.system_prompt should be "review", got ${snapshot.configValues?.system_prompt}`);
  assert(snapshot.configValues?.thinking === "high",
    `disk configValues.thinking should be "high", got ${snapshot.configValues?.thinking}`);
  // history[0] should be the review template's prompt — partial substring
  // match keeps this resilient to minor wording tweaks in cli.ts's
  // BUILTIN_SYSTEM_PROMPTS.
  const sysMsg = snapshot.history[0];
  assert(sysMsg && sysMsg.role === "system",
    `history[0] should be a system message, got role=${sysMsg?.role}`);
  assert(typeof sysMsg.content === "string" && /code reviewer/i.test(sysMsg.content),
    `history[0].content should match the "review" template (contain "code reviewer"), got: ${String(sysMsg.content).slice(0, 200)}`);
  console.error("[smoke-config-options] ✓ disk has system_prompt=review, thinking=high, and history[0] is the review prompt");

  // ── Second process: load, verify currentValue persistence ──────────────
  const b = spawnAgent(workCwd);
  await b.conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  const loaded = await b.conn.loadSession({
    cwd: workCwd,
    sessionId: snapshot.id,
    mcpServers: [],
  });
  const loadedOpts = (loaded as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  assert(currentValueOf(findOption(loadedOpts, "system_prompt")) === "review",
    `after loadSession, system_prompt should still be "review"`);
  assert(currentValueOf(findOption(loadedOpts, "thinking")) === "high",
    `after loadSession, thinking should still be "high"`);
  console.error("[smoke-config-options] ✓ session/load restores system_prompt=review, thinking=high");

  b.child.kill();
  await waitExit(b.child);

  console.error("[smoke-config-options] PASS");
}

function waitExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once("exit", () => resolve());
    setTimeout(() => resolve(), 1500);
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-config-options] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-config-options] uncaught:", err);
  process.exit(1);
});
