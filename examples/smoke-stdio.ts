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
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts")],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"], // stderr inherited so we see invox logs
      env: {
        ...process.env,
        INVOX_LOG: "info",
        INVOX_MOCK: "1", // force EchoProvider regardless of ambient env
      },
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

  // 3) Turn 1: send "hello invox"
  await runTurn({
    conn,
    updates,
    sessionId: sessRes.sessionId,
    userText: "hello invox",
    expectMarker: "hello invox",
    label: "turn 1",
  });

  // 4) Turn 2: same session, different text → exercises multi-turn history
  // accumulation. EchoProvider quotes the last user message, so we can verify
  // history was indeed replayed and the *latest* message is what's echoed.
  await runTurn({
    conn,
    updates,
    sessionId: sessRes.sessionId,
    userText: "second prompt",
    expectMarker: "second prompt",
    label: "turn 2",
  });

  // Done. Tear down.
  child.kill();
  console.error("[smoke] PASS");
}

interface RunTurnArgs {
  conn: ClientSideConnection;
  updates: SessionNotification[];
  sessionId: string;
  userText: string;
  expectMarker: string;
  label: string;
}

async function runTurn(args: RunTurnArgs): Promise<void> {
  const before = args.updates.length;
  const promptRes = await args.conn.prompt({
    sessionId: args.sessionId,
    prompt: [{ type: "text", text: args.userText }],
  });
  assert(
    promptRes.stopReason === "end_turn",
    `${args.label}: expected stopReason=end_turn, got ${promptRes.stopReason}`,
  );

  const newUpdates = args.updates.slice(before);
  const chunks = newUpdates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });
  assert(chunks.length >= 2, `${args.label}: expected multiple chunks, got ${chunks.length}`);
  const assembled = chunks.join("");
  assert(
    assembled.includes(args.expectMarker),
    `${args.label}: assembled missing "${args.expectMarker}": "${assembled}"`,
  );
  console.error(`[smoke] ✓ ${args.label}: ${chunks.length} chunks → "${assembled}"`);
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
