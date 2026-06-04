// A5 / K9 acceptance harness — provider error → stopReason mapping.
//
// 验证 prompt() 在 5 种 provider 失败下都：
//   1. 不向 ACP RPC 抛异常
//   2. 返回 stopReason="refusal"（除 abort 外）
//   3. emit 一条 agent_message_chunk 把错误说给用户听（以 ⚠️ 起首）
//
// 用一个子进程跑同一个 invox 实例完成全部 5 个子场景：
// 每次 prompt 都会触发不同 INVOX_FLAKY_KIND … 但 INVOX_FLAKY_KIND 是启动期
// 读的，所以我们改为分别 spawn 5 次（每次都很快）。
//
// Run: npx tsx examples/smoke-error-mapping.ts

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

interface Scenario {
  kind: string;
  /** 期望的 stopReason —— 全部 refusal */
  expectStopReason: "refusal";
  /** 期望出现在 agent_message_chunk 文本里的关键字 */
  expectErrorKeyword: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    kind: "429",
    expectStopReason: "refusal",
    expectErrorKeyword: /429|rate-limited/i,
  },
  {
    kind: "500",
    expectStopReason: "refusal",
    expectErrorKeyword: /500|server error/i,
  },
  {
    kind: "auth",
    expectStopReason: "refusal",
    expectErrorKeyword: /401|INVOX_API_KEY|auth/i,
  },
  {
    kind: "network",
    expectStopReason: "refusal",
    expectErrorKeyword: /ECONNRESET|network/i,
  },
  {
    kind: "mid-stream",
    expectStopReason: "refusal",
    expectErrorKeyword: /ECONNRESET|network/i,
  },
];

async function runScenario(s: Scenario): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts")],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "warn",
        INVOX_MOCK: "flaky",
        INVOX_FLAKY_KIND: s.kind,
      },
    },
  );
  child.on("error", (err) => {
    console.error(`[smoke-err][${s.kind}] failed to spawn invox:`, err);
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
  };
  const conn = new ClientSideConnection(() => client, stream);

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  const sess = await conn.newSession({ cwd: repoRoot, mcpServers: [] });

  // 关键不变式 #1：prompt() 不抛 RPC 异常 —— 即使 provider 抛错，invox 应该
  // 返回合法 PromptResponse。如果下面这行 throw，整个 smoke 失败。
  const promptRes = await conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: `trigger ${s.kind}` }],
  });

  // 关键不变式 #2：stopReason 是预期值
  assert(
    promptRes.stopReason === s.expectStopReason,
    `[${s.kind}] expected stopReason="${s.expectStopReason}", got "${promptRes.stopReason}"`,
  );

  // 关键不变式 #2.5（B4）：refusal 时 _meta["invox/error"] 携带结构化错误信息
  // ACP 协议 PromptResponse._meta 是官方扩展点，客户端可机读但不强制。
  // 我们在 invox 这边的契约：refusal 必给 _meta["invox/error"]，含 category +
  // message，可选 status / code。
  const meta = promptRes._meta as
    | { "invox/error"?: Record<string, unknown> }
    | null
    | undefined;
  const errMeta = meta?.["invox/error"];
  assert(
    !!errMeta && typeof errMeta === "object",
    `[${s.kind}] expected _meta["invox/error"] object, got: ${JSON.stringify(promptRes._meta)}`,
  );
  assert(
    typeof errMeta.category === "string" && errMeta.category.length > 0,
    `[${s.kind}] _meta.invox/error.category should be string, got: ${JSON.stringify(errMeta)}`,
  );
  assert(
    typeof errMeta.message === "string" && errMeta.message.length > 0,
    `[${s.kind}] _meta.invox/error.message should be string, got: ${JSON.stringify(errMeta)}`,
  );

  // 关键不变式 #3：emit 了 agent_message_chunk 描述错误
  const messageChunks = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => {
      const upd = u.update as Extract<
        typeof u.update,
        { sessionUpdate: "agent_message_chunk" }
      >;
      return upd.content.type === "text" ? upd.content.text : "";
    })
    .join("");

  // mid-stream 场景：消息里既有"Starting reply, but then"也有错误信息
  // 其它场景：仅错误信息
  assert(
    s.expectErrorKeyword.test(messageChunks),
    `[${s.kind}] expected error keyword ${s.expectErrorKeyword} in message_chunk, got: ${messageChunks.slice(0, 200)}`,
  );
  assert(
    /⚠️/.test(messageChunks),
    `[${s.kind}] expected ⚠️ marker in message_chunk, got: ${messageChunks.slice(0, 200)}`,
  );

  if (s.kind === "mid-stream") {
    // 验证 mid-stream 也保留了已流出来的部分文本
    assert(
      /Starting reply/.test(messageChunks),
      `[mid-stream] expected partial text "Starting reply" before error, got: ${messageChunks.slice(0, 200)}`,
    );
  }

  child.kill();
  console.error(
    `[smoke-err] ✓ kind=${s.kind} → stopReason=${promptRes.stopReason}, _meta.invox/error.category=${String(errMeta.category)}`,
  );
}

async function main(): Promise<void> {
  for (const s of SCENARIOS) {
    await runScenario(s);
  }
  console.error("[smoke-err] PASS");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-err] FAIL:", msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-err] uncaught:", err);
  process.exit(1);
});
