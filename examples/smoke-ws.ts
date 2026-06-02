// Stage 4 acceptance harness — exercises ACP over WebSocket end-to-end.
//
// Flow:
//   1) spawn invox with `--ws --port 9744`
//   2) wait for "ws transport: listening" log on stderr
//   3) connect a `ws` client
//   4) wrap the WS in a Stream<AnyMessage> (mirrors what websocket.ts does
//      on the agent side, but client-flavored)
//   5) drive a full ClientSideConnection through it: initialize / session/new /
//      prompt with INVOX_MOCK=1 (Echo) so we have deterministic output
//
// Run: npx tsx examples/smoke-ws.ts

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const PORT = 9744;
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repoRoot, "src/cli.ts"),
      "--ws",
      "--port",
      String(PORT),
      "--host",
      HOST,
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"], // capture stderr to detect "listening"
      env: { ...process.env, INVOX_LOG: "info", INVOX_MOCK: "1" },
    },
  );

  // Wait for the "listening" line on stderr before we attempt to connect.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      process.stderr.write(chunk);
      if (buf.includes("ws transport: listening")) {
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stderr?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`invox exited early: ${code}`)));
    setTimeout(() => reject(new Error("timeout waiting for ws listen")), 8000);
  });
  // Keep streaming subsequent stderr to console for visibility.
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  console.error("[smoke-ws] invox is listening, opening WebSocket");
  const ws = new WebSocket(`ws://${HOST}:${PORT}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  console.error("[smoke-ws] ✓ ws connected");

  const stream = wsClientStream(ws);

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
  console.error("[smoke-ws] ✓ initialize");

  const sess = await conn.newSession({ cwd: repoRoot, mcpServers: [] });
  console.error("[smoke-ws] ✓ session/new ->", sess.sessionId);

  const promptRes = await conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "hello over websocket" }],
  });
  assert(promptRes.stopReason === "end_turn", `expected end_turn, got ${promptRes.stopReason}`);

  const chunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<typeof u.update, { sessionUpdate: "agent_message_chunk" }>;
      return upd.content.type === "text" ? upd.content.text : "";
    });
  assert(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  const assembled = chunks.join("");
  assert(assembled.includes("hello over websocket"), `missing user text: ${assembled}`);
  console.error(`[smoke-ws] ✓ ${chunks.length} chunks → "${assembled}"`);

  ws.close();
  child.kill();
  console.error("[smoke-ws] PASS");
}

/**
 * Client-side mirror of the agent-side wsToStream. Same shape; written here
 * inline rather than imported because the agent's helper isn't a public export.
 */
function wsClientStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on("message", (data) => {
        try {
          const text = typeof data === "string" ? data : data.toString();
          const msg = JSON.parse(text) as AnyMessage;
          controller.enqueue(msg);
        } catch {
          // ignore malformed
        }
      });
      ws.on("close", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      ws.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      });
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      return new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify(msg), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  });
  return { readable, writable };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-ws] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-ws] uncaught:", err);
  process.exit(1);
});
