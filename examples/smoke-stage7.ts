// stage 7 smoke: persistence + loadSession round-trip.
//
// Scenario:
//   1. Spawn invox over stdio with a fresh tmp cwd.
//   2. initialize → confirm loadSession capability is advertised.
//   3. session/new → send a prompt → wait for end_turn.
//   4. Verify the session file exists under <cwd>/.invox/sessions/<id>.json.
//   5. Spawn a SECOND invox process in the same cwd.
//   6. initialize on the new one.
//   7. session/load with the same sessionId.
//   8. Capture the session/update notifications during load → assert the
//      historical user_message_chunk and agent_message_chunk arrive.
//   9. Send a new prompt → confirm history was carried (historyLen > 0
//      in invox's logs would be ideal but we settle for: we get a reply).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  AgentSideConnection,
  ndJsonStream,
  ClientSideConnection,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "src", "cli.ts");
const projectRoot = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "invox-stage7-"));
console.error(`[stage7] tmp cwd: ${tmp}`);

function spawnInvox(): ChildProcessWithoutNullStreams {
  // Spawn with the PROJECT root as the process cwd (so node finds tsx,
  // @zed-industries/agent-client-protocol, etc.). The session-level cwd is
  // passed separately via ACP session/new params, mimicking how Zed
  // launches invox: child process from invox's install dir, but the user's
  // project for the session.
  return spawn(
    process.execPath,
    ["--import", "tsx", cliPath, "--stdio"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        INVOX_MOCK: "1",
        INVOX_LOG: "info",
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
}

async function withInvox<T>(fn: (client: ClientSideConnection) => Promise<T>): Promise<T> {
  const child = spawnInvox();
  const out = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inp = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(out, inp);

  const updates: SessionNotification[] = [];
  const clientImpl: Client = {
    async sessionUpdate(params) {
      updates.push(params);
    },
    async requestPermission() {
      return { outcome: { outcome: "selected", optionId: "allow" } };
    },
  };
  const client = new ClientSideConnection(() => clientImpl, stream);
  // Stash updates onto the client object so caller can introspect.
  (client as any).__updates = updates;

  try {
    return await fn(client);
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[stage7] FAIL: ${msg}`);
    process.exit(1);
  }
}

// ── Phase 1: create + prompt + persist ──────────────────────────────────
const sessionId = await withInvox(async (client) => {
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  assert(
    init.agentCapabilities?.loadSession === true,
    `1. agent should advertise loadSession=true; got ${JSON.stringify(init.agentCapabilities)}`,
  );
  console.error("[stage7] ✓ phase 1 init: loadSession=true advertised");

  const sess = await client.newSession({ cwd: tmp, mcpServers: [] });
  console.error(`[stage7] ✓ phase 1 session/new -> ${sess.sessionId}`);

  const res = await client.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "hello stage 7" }],
  });
  assert(res.stopReason === "end_turn", `1. expected end_turn, got ${res.stopReason}`);
  console.error("[stage7] ✓ phase 1 prompt -> end_turn");

  return sess.sessionId;
});

// File should now exist.
const sessFile = join(tmp, ".invox", "sessions", `${sessionId}.json`);
assert(existsSync(sessFile), `2. session file should exist at ${sessFile}`);
const persisted = JSON.parse(readFileSync(sessFile, "utf8"));
assert(persisted.id === sessionId, `2. persisted id mismatch`);
assert(
  Array.isArray(persisted.history) && persisted.history.length >= 2,
  `2. history should have ≥2 messages (user + assistant), got ${persisted.history?.length}`,
);
assert(
  persisted.history[0].role === "user" && persisted.history[0].content === "hello stage 7",
  `2. first message should be the user prompt`,
);
console.error("[stage7] ✓ phase 1 file persisted under .invox/sessions/");

// ── Phase 2: new process, loadSession replays history ───────────────────
await withInvox(async (client) => {
  await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });

  const updatesBefore = ((client as any).__updates as SessionNotification[]).length;
  await client.loadSession({ sessionId, cwd: tmp, mcpServers: [] });

  const updates = (client as any).__updates as SessionNotification[];
  const replay = updates.slice(updatesBefore);
  assert(replay.length > 0, `3. loadSession should emit ≥1 session/update; got 0`);

  const userChunks = replay.filter(
    (u) => u.update.sessionUpdate === "user_message_chunk",
  );
  const agentChunks = replay.filter(
    (u) => u.update.sessionUpdate === "agent_message_chunk",
  );
  assert(userChunks.length >= 1, `3. expected ≥1 user_message_chunk during replay`);
  assert(agentChunks.length >= 1, `3. expected ≥1 agent_message_chunk during replay`);
  console.error(
    `[stage7] ✓ phase 2 loadSession replayed ${userChunks.length} user + ${agentChunks.length} agent chunks`,
  );

  // The reloaded session should behave like a continuing session — sending
  // a follow-up prompt should succeed, and history should now have grown.
  const res = await client.prompt({
    sessionId,
    prompt: [{ type: "text", text: "follow-up after reload" }],
  });
  assert(res.stopReason === "end_turn", `4. follow-up prompt failed: ${res.stopReason}`);
  console.error("[stage7] ✓ phase 2 follow-up prompt after loadSession -> end_turn");
});

// Final disk state should now have BOTH prompts in history.
const finalPersisted = JSON.parse(readFileSync(sessFile, "utf8"));
const userMsgs = finalPersisted.history.filter((m: any) => m.role === "user");
assert(
  userMsgs.length === 2,
  `5. final history should have 2 user messages (original + follow-up), got ${userMsgs.length}`,
);
console.error("[stage7] ✓ phase 2 follow-up was persisted (history has both user msgs)");

// ── Phase 3: title is derived from first user message ───────────────────
assert(
  typeof finalPersisted.title === "string" && finalPersisted.title.startsWith("hello stage 7"),
  `6. title should start with first user message, got ${JSON.stringify(finalPersisted.title)}`,
);
console.error(`[stage7] ✓ phase 3 title set: ${JSON.stringify(finalPersisted.title)}`);

// ── Phase 4: prune deletes old sessions ─────────────────────────────────
{
  // Forge an "old" session by writing one with updatedAt 100 days ago
  // into the same store. Then run prune via env-driven TTL=30. Expect
  // the old one gone and our real session intact.
  const fakeOldId = "00000000-0000-0000-0000-000000000aaa";
  const oldFile = join(tmp, ".invox", "sessions", `${fakeOldId}.json`);
  const ms100d = 100 * 24 * 60 * 60 * 1000;
  const old = {
    version: 1,
    id: fakeOldId,
    cwd: tmp,
    title: "(old test session)",
    createdAt: Date.now() - ms100d,
    updatedAt: Date.now() - ms100d,
    history: [{ role: "user", content: "long ago" }],
  };
  // mkdirSync was already done by phase 1's save(); just write directly.
  // Use the persistence module's API would create a circular import in this
  // example file, so we just write here with fs.
  // (Both files exist now: the real session + the fake old one.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = await import("node:fs");
  fs.writeFileSync(oldFile, JSON.stringify(old, null, 2), "utf8");

  // Trigger prune by spinning up a fresh invox in the same cwd and
  // sending one prompt. agent.persist() runs prune() on first save.
  await withInvox(async (client) => {
    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    const sess = await client.newSession({ cwd: tmp, mcpServers: [] });
    await client.prompt({
      sessionId: sess.sessionId,
      prompt: [{ type: "text", text: "trigger prune" }],
    });
  });

  assert(!existsSync(oldFile), `7. prune should have deleted the 100-day-old session at ${oldFile}`);
  assert(existsSync(sessFile), `7. prune should NOT have touched the recent session`);
  console.error("[stage7] ✓ phase 4 prune deletes old, keeps recent");
}

console.error("[stage7] PASS");
