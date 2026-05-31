// Stage 1 acceptance harness — external evidence that ACP-over-stdio works
// end-to-end. Spawns invox as a subprocess, plays the role of the client,
// runs initialize → newSession → prompt, asserts streamed updates arrive.
//
// Run: node --import tsx examples/smoke-stdio.ts
// Or:  npx tsx examples/smoke-stdio.ts

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
} from "@zed-industries/agent-client-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts")],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"], // stderr inherited so we see invox logs
      env: { ...process.env, INVOX_LOG: "info" },
    },
  );

  child.on("error", (err) => {
    console.error("[smoke] failed to spawn invox:", err);
    process.exit(1);
  });

  // Wrap child stdio as Web Streams of bytes, then as an ACP message Stream.
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  // Capture sessionUpdate notifications.
  const updates: SessionNotification[] = [];
  const client: Client = {
    async sessionUpdate(params) {
      updates.push(params);
    },
    async requestPermission() {
      throw new Error("not implemented in smoke test");
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  // 1) initialize
  const initRes = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  assert(
    initRes.protocolVersion === PROTOCOL_VERSION,
    `expected protocolVersion=${PROTOCOL_VERSION}, got ${initRes.protocolVersion}`,
  );
  console.error("[smoke] ✓ initialize");

  // 2) session/new
  const sessRes = await conn.newSession({
    cwd: repoRoot,
    mcpServers: [],
  });
  assert(typeof sessRes.sessionId === "string" && sessRes.sessionId.length > 0, "missing sessionId");
  console.error("[smoke] ✓ session/new ->", sessRes.sessionId);

  // 3) session/prompt — expect streamed agent_message_chunks
  const promptRes = await conn.prompt({
    sessionId: sessRes.sessionId,
    prompt: [{ type: "text", text: "hello invox" }],
  });
  assert(promptRes.stopReason === "end_turn", `expected stopReason=end_turn, got ${promptRes.stopReason}`);
  console.error("[smoke] ✓ session/prompt ->", promptRes.stopReason);

  // 4) verify chunks arrived and assemble them
  const chunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });
  assert(chunks.length >= 2, `expected multiple chunks (streaming), got ${chunks.length}`);
  const assembled = chunks.join("");
  assert(assembled.includes("hello invox"), `assembled reply missing user text: "${assembled}"`);
  assert(assembled.includes("streaming works"), `assembled reply missing marker: "${assembled}"`);
  console.error(`[smoke] ✓ received ${chunks.length} chunks, assembled: "${assembled}"`);

  // Done. Tear down.
  child.kill();
  console.error("[smoke] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
