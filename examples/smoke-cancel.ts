// Stage 5 acceptance harness — proves session/cancel halts an in-flight
// stream mid-flight and the prompt resolves with stopReason="cancelled".
//
// Strategy: EchoProvider yields 8-char chunks every 20ms. We send a prompt
// whose total reply spans ~150ms, fire session/cancel after ~50ms, then
// await the prompt response. Expectations:
//   - stopReason === "cancelled"
//   - chunks received < what we'd see without cancel (proves we caught it
//     mid-stream, not after natural completion)
//
// Run: npx tsx examples/smoke-cancel.ts

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
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
      env: { ...process.env, INVOX_LOG: "info", INVOX_MOCK: "1" },
    },
  );
  child.on("error", (err) => {
    console.error("[smoke-cancel] spawn failed:", err);
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
      throw new Error("not used");
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
  });
  console.error("[smoke-cancel] ✓ initialize");

  const sess = await conn.newSession({ cwd: repoRoot, mcpServers: [] });
  console.error("[smoke-cancel] ✓ session/new ->", sess.sessionId);

  // Big input → big echo reply → many 20ms chunks → wide cancel window.
  const padding = "X".repeat(60);
  const promptPromise = conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: `cancel-test ${padding}` }],
  });

  // Fire cancel after 50ms — partway through streaming.
  await sleep(50);
  console.error("[smoke-cancel] sending session/cancel");
  await conn.cancel({ sessionId: sess.sessionId });

  const promptRes = await promptPromise;
  assert(
    promptRes.stopReason === "cancelled",
    `expected cancelled, got ${promptRes.stopReason}`,
  );
  console.error("[smoke-cancel] ✓ stopReason =", promptRes.stopReason);

  const chunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });

  const expectedFullChunkCount = Math.ceil(`invox echo: you said "cancel-test ${padding}". streaming works ✓`.length / 8);
  assert(
    chunks.length > 0,
    `expected at least 1 chunk before cancel, got ${chunks.length}`,
  );
  assert(
    chunks.length < expectedFullChunkCount,
    `expected partial stream (<${expectedFullChunkCount} chunks), got ${chunks.length} — cancel didn't halt mid-stream`,
  );
  console.error(
    `[smoke-cancel] ✓ ${chunks.length} chunks received (would-be-full: ${expectedFullChunkCount}) — cancel landed mid-stream`,
  );

  child.kill();
  console.error("[smoke-cancel] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-cancel] FAIL:", msg);
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[smoke-cancel] uncaught:", err);
  process.exit(1);
});
