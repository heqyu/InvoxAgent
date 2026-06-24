// Optional smoke test for the real LLM path via providers.json.
// Skips with a clear message if no providers.json is found so this can run
// in CI without secrets.
//
// Run:
//   npx tsx examples/smoke-openai.ts
//
// Requires ~/.invox/providers.json or .invox/providers.json in the project root.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
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
  const projectProviders = join(repoRoot, ".invox", "providers.json");
  const userProviders = join(homedir(), ".invox", "providers.json");
  if (!existsSync(projectProviders) && !existsSync(userProviders)) {
    console.error(
      "[smoke-openai] SKIP — no providers.json found (checked project and ~/.invox/)",
    );
    process.exit(0);
  }

  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts")],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "info",
      },
    },
  );

  child.on("error", (err) => {
    console.error("[smoke-openai] failed to spawn invox:", err);
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
      throw new Error("not used in stage 2");
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  console.error("[smoke-openai] ✓ initialize");

  const { sessionId } = await conn.newSession({ cwd: repoRoot, mcpServers: [] });
  console.error("[smoke-openai] ✓ session/new ->", sessionId);

  const promptRes = await conn.prompt({
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Reply with the single word: pong",
      },
    ],
  });
  assert(
    promptRes.stopReason === "end_turn",
    `expected stopReason=end_turn, got ${promptRes.stopReason}`,
  );

  const chunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });
  assert(chunks.length >= 1, "expected ≥1 streamed chunk from real LLM");
  const assembled = chunks.join("");
  assert(assembled.length > 0, "assembled reply is empty");
  console.error(
    `[smoke-openai] ✓ ${chunks.length} chunks, ${assembled.length} chars: "${assembled.slice(0, 80)}${assembled.length > 80 ? "..." : ""}"`,
  );

  child.kill();
  console.error("[smoke-openai] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-openai] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-openai] uncaught:", err);
  process.exit(1);
});
