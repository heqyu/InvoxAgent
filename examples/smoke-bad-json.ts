// A3 / K5 acceptance harness — bad-JSON tool_call recovery.
//
// Asserts that:
//   1. invox does NOT crash when an LLM emits malformed JSON tool args
//   2. The tool_call_update notification has status="failed" and a useful
//      error message in `content`
//   3. The agent loop continues — LLM gets the error as tool result and
//      can self-correct (BadJsonProvider phase 2 retries with valid JSON)
//   4. The corrected tool_call succeeds and the turn ends normally with
//      end_turn (not max_turn_requests, not exception)
//
// Run: npx tsx examples/smoke-bad-json.ts

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
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

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts")],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "info",
        INVOX_MOCK: "bad-json",
      },
    },
  );
  child.on("error", (err) => {
    console.error("[smoke-bad-json] failed to spawn invox:", err);
    process.exit(1);
  });

  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const updates: SessionNotification[] = [];
  const fsReadCalls: ReadTextFileRequest[] = [];
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
      fsReadCalls.push(params);
      const content = readFileSync(params.path, "utf8");
      return { content };
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  console.error("[smoke-bad-json] ✓ initialize");

  const sess = await conn.newSession({ cwd: repoRoot, mcpServers: [] });
  console.error("[smoke-bad-json] ✓ session/new ->", sess.sessionId);

  const promptRes = await conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "trigger bad-json scenario" }],
  });
  // 关键不变式 #1：agent 没有挂；prompt 返回了合法 stopReason
  assert(
    promptRes.stopReason === "end_turn",
    `expected end_turn, got ${promptRes.stopReason}`,
  );
  console.error("[smoke-bad-json] ✓ stopReason =", promptRes.stopReason);

  const toolCallStarts = updates.filter(
    (u) => u.update.sessionUpdate === "tool_call",
  );
  const toolCallUpdates = updates.filter(
    (u) => u.update.sessionUpdate === "tool_call_update",
  );

  // 关键不变式 #2：第一次 tool_call 应当 emit 了 status="failed" 的 update
  assert(
    toolCallStarts.length === 2,
    `expected 2 tool_call notifications (1 bad + 1 retry), got ${toolCallStarts.length}`,
  );
  assert(
    toolCallUpdates.length >= 1,
    `expected ≥1 tool_call_update, got ${toolCallUpdates.length}`,
  );

  const failedUpdates = toolCallUpdates.filter((u) => {
    const upd = u.update as Extract<
      SessionNotification["update"],
      { sessionUpdate: "tool_call_update" }
    >;
    return upd.status === "failed";
  });
  assert(
    failedUpdates.length === 1,
    `expected exactly 1 failed tool_call_update, got ${failedUpdates.length}`,
  );

  const failedUpdate = failedUpdates[0]?.update as Extract<
    SessionNotification["update"],
    { sessionUpdate: "tool_call_update" }
  >;
  // failed update 应当带有 'bad arguments' 的 title 标记
  assert(
    /bad arguments/i.test(failedUpdate.title ?? ""),
    `failed update title missing 'bad arguments': ${failedUpdate.title}`,
  );
  // content 里应当解释 JSON 错误
  const failedText = JSON.stringify(failedUpdate.content ?? []);
  assert(
    /not valid JSON|JSON object/i.test(failedText),
    `failed update content missing JSON error: ${failedText}`,
  );

  // 关键不变式 #3：自我纠错路径打通 —— agent 收到 fs.readTextFile 1 次
  // （第一次 bad JSON 没走到 fs，第二次 retry 走到了）
  assert(
    fsReadCalls.length === 1,
    `expected 1 fs.readTextFile (retry only), got ${fsReadCalls.length}`,
  );

  // 关键不变式 #4：第二次 tool_call 的 update 是 completed
  const completedUpdates = toolCallUpdates.filter((u) => {
    const upd = u.update as Extract<
      SessionNotification["update"],
      { sessionUpdate: "tool_call_update" }
    >;
    return upd.status === "completed";
  });
  assert(
    completedUpdates.length === 1,
    `expected 1 completed tool_call_update, got ${completedUpdates.length}`,
  );

  console.error(
    `[smoke-bad-json] ✓ bad JSON → failed update → self-correction → completed`,
  );

  child.kill();
  console.error("[smoke-bad-json] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-bad-json] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-bad-json] uncaught:", err);
  process.exit(1);
});
