// Phase G acceptance harness — 自定义 Agent 模板下拉端到端验证。
//
// 验证场景：
//   1. session/new 暴露 "agent" 下拉、不暴露 "system_prompt"
//   2. set_config_option(agent=Plan) 重写 history[0] 为 Plan 模板 prompt
//   3. 项目级 .invox/agents/Custom.json 出现在下拉里
//   4. session/load 后 currentValue 仍为 Plan
//
// Run: npx tsx examples/smoke-agents.ts

import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

interface Spawned {
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
}

function spawnAgent(workCwd: string): Spawned {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src/cli.ts"), "--stdio"],
    {
      // cwd=repoRoot 让 --import tsx 能从 node_modules 解析；
      // INVOX_AGENTS_DIR 显式告诉 invox 去 workCwd 下扫 .invox/agents/
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        INVOX_LOG: "warn",
        INVOX_MOCK: "tools",
        INVOX_AGENTS_DIR: workCwd,
        INVOX_SESSION_DIR: join(workCwd, ".invox", "sessions"),
      },
    },
  ) as ChildProcessWithoutNullStreams;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  const client: Client = {
    async sessionUpdate() {},
    async requestPermission() {
      throw new Error("not used");
    },
    async readTextFile(
      params: ReadTextFileRequest,
    ): Promise<ReadTextFileResponse> {
      return { content: readFileSync(params.path, "utf8") };
    },
  };
  return { child, conn: new ClientSideConnection(() => client, stream) };
}

function findOpt(
  options: SessionConfigOption[],
  id: string,
): SessionConfigOption | undefined {
  return options.find((o) => o.id === id);
}

function curValOf(opt: SessionConfigOption): string {
  const v = (opt as { currentValue?: unknown }).currentValue;
  if (typeof v !== "string") {
    throw new Error(
      `expected string currentValue on ${opt.id}, got: ${String(v)}`,
    );
  }
  return v;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("[smoke-agents] FAIL:", msg);
    process.exit(1);
  }
}

function waitExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once("exit", () => resolve());
    setTimeout(() => resolve(), 1500);
  });
}

async function main(): Promise<void> {
  const workCwd = mkdtempSync(join(tmpdir(), "invox-smoke-agents-"));
  console.error("[smoke-agents] cwd:", workCwd);

  // 写项目级 Custom agent —— 验证 .invox/agents/ 加载
  const agentsDir = join(workCwd, ".invox", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "Custom.json"),
    JSON.stringify(
      {
        name: "我的自定义 Agent",
        description: "禁用所有工具的玩具 agent",
        prompt: "You are CUSTOM-AGENT-MARKER, a haiku poet.",
        tools: [],
        mcp: false,
      },
      null,
      2,
    ),
    "utf8",
  );

  // ── 进程 1：开 session、验证下拉、切换到 Plan ─────────────────────
  const a = spawnAgent(workCwd);
  await a.conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
  });
  console.error("[smoke-agents] ✓ initialize");

  const sess = await a.conn.newSession({ cwd: workCwd, mcpServers: [] });
  const initialOpts =
    (sess as { configOptions?: SessionConfigOption[] }).configOptions ?? [];

  // 应有 agent 下拉、不应有 system_prompt 下拉
  const agentOpt = findOpt(initialOpts, "agent");
  assert(agentOpt, `expected "agent" dropdown, got: ${initialOpts.map((o) => o.id).join(",")}`);
  assert(
    !findOpt(initialOpts, "system_prompt"),
    `"system_prompt" must be hidden when agents loaded, got it`,
  );
  console.error("[smoke-agents] ✓ agent dropdown advertised, system_prompt hidden");

  // Custom 应出现在选项列表里（项目级覆盖）
  const opts = (agentOpt as { options?: { value: string }[] }).options ?? [];
  const ids = opts.map((o) => o.value);
  assert(ids.includes("Custom"), `Custom agent missing from dropdown: ${ids.join(",")}`);
  assert(ids.includes("Plan"), `Plan builtin missing: ${ids.join(",")}`);
  assert(ids.includes("Worker"), `Worker builtin missing: ${ids.join(",")}`);
  console.error("[smoke-agents] ✓ project Custom + builtins all present:", ids.join(","));

  // 默认应该是 Worker
  assert(
    curValOf(agentOpt) === "Worker",
    `default agent should be "Worker", got ${curValOf(agentOpt)}`,
  );

  // 切到 Plan
  const setRes = await a.conn.setSessionConfigOption({
    sessionId: sess.sessionId,
    configId: "agent",
    value: "Plan",
  });
  const afterOpts =
    (setRes as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  const newAgentOpt = findOpt(afterOpts, "agent");
  assert(newAgentOpt && curValOf(newAgentOpt) === "Plan", `set agent=Plan failed`);
  console.error("[smoke-agents] ✓ set_config_option(agent=Plan)");

  // 跑一轮 prompt 触发持久化
  writeFileSync(join(workCwd, "package.json"), '{"name":"smoke-agents"}');
  const pr = await a.conn.prompt({
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: 'please read "package.json"' }],
  });
  assert(pr.stopReason === "end_turn", `expected end_turn, got ${pr.stopReason}`);

  a.child.kill();
  await waitExit(a.child);

  // ── 落盘验证 ────────────────────────────────────────────────────
  const sessionsDir = join(workCwd, ".invox", "sessions");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  assert(files.length === 1, `expected 1 session file, got ${files.length}`);
  const snap = JSON.parse(readFileSync(join(sessionsDir, files[0]!), "utf8")) as {
    id: string;
    configValues?: Record<string, string>;
    history: { role: string; content: string }[];
  };
  assert(snap.configValues?.agent === "Plan", `disk configValues.agent should be Plan, got ${snap.configValues?.agent}`);
  const sysMsg = snap.history[0];
  assert(
    sysMsg && sysMsg.role === "system",
    `history[0] should be system, got role=${sysMsg?.role}`,
  );
  // Plan 模板的 prompt 含特征字串 "planning assistant"
  assert(
    typeof sysMsg.content === "string" && /planning assistant/i.test(sysMsg.content),
    `history[0] should be Plan template, got: ${String(sysMsg.content).slice(0, 200)}`,
  );
  console.error("[smoke-agents] ✓ disk: configValues.agent=Plan, history[0] is Plan template");

  // ── 进程 2：load + 验证 currentValue 仍为 Plan ─────────────────
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
    sessionId: snap.id,
    mcpServers: [],
  });
  const loadedOpts =
    (loaded as { configOptions?: SessionConfigOption[] }).configOptions ?? [];
  const loadedAgent = findOpt(loadedOpts, "agent");
  assert(
    loadedAgent && curValOf(loadedAgent) === "Plan",
    `after loadSession, agent should still be "Plan"`,
  );
  console.error("[smoke-agents] ✓ session/load restores agent=Plan");

  b.child.kill();
  await waitExit(b.child);

  console.error("[smoke-agents] PASS");
}

main().catch((err) => {
  console.error("[smoke-agents] uncaught:", err);
  process.exit(1);
});
