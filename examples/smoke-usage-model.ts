// Stage 8 acceptance harness — model selection + per-turn token usage.
//
// Uses the standard `ClientSideConnection` from @agentclientprotocol/sdk@0.23.
// The previous version of this file hand-rolled an NDJSON JSON-RPC client
// because the deprecated @zed-industries/agent-client-protocol@0.4.5
// shipped a `setSessionModel(...)` client helper that sent the wrong method
// name (`session/set_mode` instead of `session/set_model`); the new SDK
// renames the helper to `unstable_setSessionModel` and wires it correctly.
//
// Flow:
//   1. Spawn invox with INVOX_MOCK=tools and INVOX_MODELS="alpha,beta".
//   2. initialize → expect protocolVersion echoed.
//   3. session/new → assert response.models has both ids and current=alpha.
//   4. unstable_setSessionModel(beta) → assert success ({}).
//   5. session/prompt(...) → assert end_turn AND PromptResponse.usage carries
//      the synthetic token counts MockToolProvider yields.
//   6. SessionUpdate notifications must include exactly one `usage_update`
//      and one `agent_thought_chunk` (the visible-today fallback).
//   7. Read on-disk session JSON; assert selectedModel === "beta".
//   8. Spawn a SECOND invox; session/load → assert models.currentModelId=beta.
//
// Run: npx tsx examples/smoke-usage-model.ts

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
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
  type SessionNotification,
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

interface SpawnedAgent {
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
  updates: SessionNotification[];
}

function spawnAgent(sessionCwd: string): SpawnedAgent {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts"), "--stdio"],
    {
      // Spawn from the project root so node finds tsx + ACP SDK. The
      // session-level cwd (where .invox/sessions/ goes) flows in via
      // session/new params, NOT process cwd.
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "info",
        INVOX_MOCK: "tools",
        INVOX_MODELS: "alpha,beta",
        INVOX_MODEL: "alpha",
        // Pin session store inside our throw-away dir so the disk
        // assertion finds the file deterministically.
        INVOX_SESSION_DIR: join(sessionCwd, ".invox", "sessions"),
      },
    },
  ) as ChildProcessWithoutNullStreams;
  child.on("error", (err) => {
    console.error("[smoke-usage-model] spawn failed:", err);
    process.exit(1);
  });

  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const updates: SessionNotification[] = [];
  const client: Client = {
    async sessionUpdate(params) {
      updates.push(params);
    },
    async requestPermission() {
      throw new Error("not used (policy: never ask)");
    },
    async readTextFile(
      params: ReadTextFileRequest,
    ): Promise<ReadTextFileResponse> {
      // MockToolProvider asks for package.json by default — serve from
      // the session cwd so the round-trip completes.
      return { content: readFileSync(params.path, "utf8") };
    },
  };
  const conn = new ClientSideConnection(() => client, stream);
  return { child, conn, updates };
}

async function main(): Promise<void> {
  const workCwd = mkdtempSync(join(tmpdir(), "invox-smoke-usage-"));
  console.error("[smoke-usage-model] cwd:", workCwd);

  // ── First process: new session, set model to beta, prompt ──────────────
  const a = spawnAgent(workCwd);

  await a.conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  console.error("[smoke-usage-model] ✓ initialize");

  const sess = await a.conn.newSession({ cwd: workCwd, mcpServers: [] });
  assert(!!sess.sessionId, "sessionId missing on session/new response");
  // The `models` field is `unstable_session_model` in the new SDK and
  // optional on NewSessionResponse — assert it's populated.
  const models = (
    sess as {
      models?: {
        availableModels: { modelId: string }[];
        currentModelId: string;
      };
    }
  ).models;
  assert(!!models, "session/new response missing models");
  const ids = models.availableModels.map((m) => m.modelId);
  assert(
    ids.includes("alpha") && ids.includes("beta"),
    `expected alpha+beta in availableModels, got ${ids.join(",")}`,
  );
  assert(
    models.currentModelId === "alpha",
    `expected currentModelId=alpha, got ${models.currentModelId}`,
  );
  console.error(
    "[smoke-usage-model] ✓ session/new.models =",
    ids,
    "current =",
    models.currentModelId,
  );

  // unstable_setSessionModel — the renamed helper that correctly emits
  // `session/set_model` (the previous SDK had a typo sending `set_mode`).
  await a.conn.unstable_setSessionModel({
    sessionId: sess.sessionId,
    modelId: "beta",
  });
  console.error("[smoke-usage-model] ✓ unstable_setSessionModel(beta)");

  // Prep a file the mock tool will read.
  writeFileSync(join(workCwd, "package.json"), '{"name":"smoke"}');

  const promptRes = await a.conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: 'please read "package.json"' }],
  });
  assert(
    promptRes.stopReason === "end_turn",
    `expected end_turn, got ${promptRes.stopReason}`,
  );
  // PromptResponse.usage is the unstable_session_usage Usage field —
  // second data path that drives Zed's token chip.
  const usage = (
    promptRes as {
      usage?: {
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
      };
    }
  ).usage;
  assert(
    !!usage,
    `expected PromptResponse.usage to be populated, got: ${JSON.stringify(promptRes)}`,
  );
  assert(
    usage.inputTokens === 42 && usage.outputTokens === 7,
    `expected usage { input: 42, output: 7 }, got: ${JSON.stringify(usage)}`,
  );
  console.error(
    "[smoke-usage-model] ✓ session/prompt → end_turn, usage:",
    usage,
  );

  // The agent should emit one `usage_update` (for Zed's beta token-meter
  // UI) and one `agent_thought_chunk` (the visible-today fallback line).
  const usageUpdates = a.updates.filter(
    (u) =>
      (u.update as { sessionUpdate: string }).sessionUpdate === "usage_update",
  );
  assert(
    usageUpdates.length === 1,
    `expected exactly 1 usage_update notification, got ${usageUpdates.length}`,
  );
  const uu = usageUpdates[0]!.update as { used: number; size: number };
  assert(uu.used === 49, `expected used=49, got ${uu.used}`);
  assert(
    typeof uu.size === "number" && uu.size > 0,
    `expected positive context-window size, got ${uu.size}`,
  );
  console.error(
    `[smoke-usage-model] ✓ usage_update emitted: used=${uu.used} size=${uu.size}`,
  );

  const thoughtChunks = a.updates.filter(
    (u) => u.update.sessionUpdate === "agent_thought_chunk",
  );
  assert(
    thoughtChunks.length === 1,
    `expected exactly 1 agent_thought_chunk (token report), got ${thoughtChunks.length}`,
  );
  const tc = thoughtChunks[0]!;
  const upd = tc.update as Extract<
    typeof tc.update,
    { sessionUpdate: "agent_thought_chunk" }
  >;
  const text = upd.content.type === "text" ? upd.content.text : "";
  assert(
    text.startsWith("🪙"),
    `agent_thought_chunk should start with 🪙, got: ${text}`,
  );
  assert(
    text.includes("beta"),
    `agent_thought_chunk should report model beta, got: ${text}`,
  );
  assert(
    text.includes("Context:") && text.includes(" / "),
    `agent_thought_chunk should report Context: used / max, got: ${text}`,
  );
  const meta = (tc as { _meta?: Record<string, unknown> })._meta;
  assert(
    !!meta && typeof meta["invox/usage"] === "object",
    "agent_thought_chunk missing _meta['invox/usage']",
  );
  console.error("[smoke-usage-model] ✓ agent_thought_chunk:", text);

  a.child.kill();
  await waitExit(a.child);

  // ── Disk persistence check ─────────────────────────────────────────────
  const sessionsDir = join(workCwd, ".invox", "sessions");
  assert(existsSync(sessionsDir), `sessions dir not created: ${sessionsDir}`);
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  assert(files.length === 1, `expected 1 session file, got ${files.length}`);
  const sessionFile = files[0]!;
  const snapshot = JSON.parse(
    readFileSync(join(sessionsDir, sessionFile), "utf8"),
  ) as {
    selectedModel?: string;
    id: string;
  };
  assert(
    snapshot.selectedModel === "beta",
    `expected selectedModel=beta on disk, got ${snapshot.selectedModel}`,
  );
  console.error(
    "[smoke-usage-model] ✓ disk has selectedModel =",
    snapshot.selectedModel,
  );

  // ── Second process: load session, expect beta restored ─────────────────
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
  const loadedModels = (
    loaded as {
      models?: {
        availableModels: { modelId: string }[];
        currentModelId: string;
      };
    }
  ).models;
  assert(!!loadedModels, "session/load response missing models");
  assert(
    loadedModels.currentModelId === "beta",
    `expected loaded currentModelId=beta, got ${loadedModels.currentModelId}`,
  );
  console.error(
    "[smoke-usage-model] ✓ session/load.models.currentModelId =",
    loadedModels.currentModelId,
  );

  b.child.kill();
  await waitExit(b.child);

  console.error("[smoke-usage-model] PASS");
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
    console.error("[smoke-usage-model] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-usage-model] uncaught:", err);
  process.exit(1);
});
