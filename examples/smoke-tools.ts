// Stage 3 acceptance harness — exercises the full LLM-tool-LLM round-trip
// with the MockToolProvider (no real LLM needed).
//
// Flow:
//   client → prompt("read 'package.json'")
//   agent  → text "Let me read package.json for you."
//   agent  → tool_call read_file(path: "package.json")
//   agent  → conn.readTextFile(...)             ← we serve this from disk
//   agent  → tool_call_update completed
//   agent  → text "Done. The file is N bytes long."
//   agent  → end_turn
//
// Run: npx tsx examples/smoke-tools.ts

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
        INVOX_MOCK: "tools", // force MockToolProvider
      },
    },
  );
  child.on("error", (err) => {
    console.error("[smoke-tools] failed to spawn invox:", err);
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
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      fsReadCalls.push(params);
      // Serve from disk — the agent's tool will call us with absolute path.
      const content = readFileSync(params.path, "utf8");
      return { content };
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  // 1) initialize — advertise readTextFile capability
  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  console.error("[smoke-tools] ✓ initialize");

  // 2) session/new
  const sess = await conn.newSession({ cwd: repoRoot, mcpServers: [] });
  console.error("[smoke-tools] ✓ session/new ->", sess.sessionId);

  // 3) prompt
  const promptRes = await conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: 'please read "package.json"' }],
  });
  assert(
    promptRes.stopReason === "end_turn",
    `expected end_turn, got ${promptRes.stopReason}`,
  );
  console.error("[smoke-tools] ✓ stopReason =", promptRes.stopReason);

  // 4) Assertions on the notifications stream
  const textChunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });
  const toolCallStarts = updates.filter((u) => u.update.sessionUpdate === "tool_call");
  const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update");

  assert(textChunks.length > 0, "expected ≥1 text chunk");
  assert(toolCallStarts.length === 1, `expected 1 tool_call, got ${toolCallStarts.length}`);
  assert(toolCallUpdates.length === 1, `expected 1 tool_call_update, got ${toolCallUpdates.length}`);
  assert(fsReadCalls.length === 1, `expected 1 fs.readTextFile call, got ${fsReadCalls.length}`);
  const firstRead = fsReadCalls[0];
  assert(!!firstRead, "fsReadCalls[0] missing");
  assert(
    firstRead.path.replace(/\\/g, "/").endsWith("package.json"),
    `expected read of package.json, got ${firstRead.path}`,
  );

  const tcStart = toolCallStarts[0]?.update as Extract<
    SessionNotification["update"],
    { sessionUpdate: "tool_call" }
  >;
  const tcEnd = toolCallUpdates[0]?.update as Extract<
    SessionNotification["update"],
    { sessionUpdate: "tool_call_update" }
  >;
  assert(tcStart.toolCallId === tcEnd.toolCallId, "tool_call/update id mismatch");
  assert(tcEnd.status === "completed", `expected completed, got ${tcEnd.status}`);

  const assembled = textChunks.join("");
  assert(/Let me read/.test(assembled), `phase-1 text missing: ${assembled}`);
  assert(/Done\. The file is \d+ bytes/.test(assembled), `phase-2 summary missing: ${assembled}`);

  console.error(
    `[smoke-tools] ✓ ${textChunks.length} text chunks, 1 tool_call→completed, fs.readTextFile served once`,
  );
  console.error(`[smoke-tools] assembled: "${assembled}"`);

  child.kill();
  console.error("[smoke-tools] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-tools] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-tools] uncaught:", err);
  process.exit(1);
});
