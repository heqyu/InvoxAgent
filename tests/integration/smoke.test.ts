// 集成测试：把 examples/smoke-*.ts 全部纳入 vitest 调度
//
// PROGRESS A1：「把已有 smoke 全部接入 vitest」 —— 不重写 smoke 的内部断言，
// 而是把每个 smoke 当作一个黑盒子进程：spawn → 等退出 → 断言 exit 0 + stderr 有
// "PASS" 标记。这样：
//   1. 保留 smoke 已有的端到端价值（真起 stdio 子进程跑 ACP 握手 / 工具循环）
//   2. 一条 `npm test` 把单元测试 + 集成测试全跑了
//   3. 后续逐 smoke 内部细化迁移到独立单测时，可一个个把 `it()` 拆开
//
// 注意：
//   - smoke 进程内部的 console.error 都会出现在 stderr —— 因此我们抓 stderr
//     找 "PASS"，stdout 仍然是 ACP JSON-RPC（与 invox 自己的 stdio 一致）
//   - smoke-plugin-real 需要外部 ECOMarket 目录，无环境变量则跳过
//   - smoke-openai 在缺 providers.json 时自身 SKIP 退出 0，
//     vitest 视为通过 —— 这也是 smoke-openai 设计意图
//   - 跨平台：用 process.execPath + ["--import", "tsx", smokeFile]，避免依赖
//     PATH 上是否有 tsx

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const examplesDir = join(repoRoot, "examples");

interface SmokeResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  signal: NodeJS.Signals | null;
}

/**
 * 跑一个 smoke 子进程并等待结束。
 *
 * timeout 触发时强杀子进程并把累积输出一起返回，让上层 expect 报错可读。
 */
async function runSmoke(
  smokeFile: string,
  opts: { timeoutMs?: number; args?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<SmokeResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(examplesDir, smokeFile), ...(opts.args ?? [])],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, INVOX_LOG: "warn", ...(opts.env ?? {}) },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));

  return new Promise<SmokeResult>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr, stdout, signal });
    });
  });
}

/** 断言一个 smoke 通过 —— 退出码 0 且 stdout 或 stderr 含 "PASS"/"SKIP"。
 *
 *  注意：smoke 分两类输出习惯：
 *    1. spawn invox 的（如 smoke-stdio）—— stdout 是 ACP JSON-RPC 通道，PASS
 *       走 stderr（console.error）
 *    2. 直接调用源码 API 的（如 smoke-skill）—— 没有协议负担，PASS 走 stdout
 *       （console.log）
 *  两边都查，覆盖两种风格。 */
function expectPass(r: SmokeResult, smokeFile: string): void {
  const stderrTail = r.stderr.slice(-1500);
  const stdoutTail = r.stdout.slice(-1500);
  expect(
    r.exitCode,
    `${smokeFile} exited with code=${r.exitCode} signal=${r.signal}\n--- stderr tail ---\n${stderrTail}\n--- stdout tail ---\n${stdoutTail}`,
  ).toBe(0);
  const combined = r.stderr + r.stdout;
  expect(
    /PASS|SKIP/.test(combined),
    `${smokeFile} did not contain PASS or SKIP in stderr or stdout\n--- stderr tail ---\n${stderrTail}\n--- stdout tail ---\n${stdoutTail}`,
  ).toBe(true);
}

// ── smoke 注册表 ───────────────────────────────────────────────────
//
// 每条 = 一个 vitest case。timeoutMs 按 smoke 体量调整。
// integration smoke 跑得慢（spawn + tsx 编译 + ACP 握手），统一给 ≥ 30s 余量。

interface SmokeCase {
  file: string;
  /** 单 case 超时（ms） */
  timeoutMs?: number;
  /** 额外环境变量 */
  env?: NodeJS.ProcessEnv;
  /** 是否默认跳过（需手动 enable） */
  skipIf?: () => boolean;
  /** skip 原因（用于报告可读性） */
  skipReason?: string;
}

const SMOKES: SmokeCase[] = [
  { file: "smoke-stdio.ts", timeoutMs: 30_000 },
  { file: "smoke-tools.ts", timeoutMs: 30_000 },
  // A3 / K5 验收：畸形 JSON tool_call 不挂 agent，且 LLM 能自我纠错
  { file: "smoke-bad-json.ts", timeoutMs: 30_000 },
  // A5 / K9 验收：5 种 provider 错误（429/500/auth/network/mid-stream）→ refusal
  { file: "smoke-error-mapping.ts", timeoutMs: 60_000 },
  { file: "smoke-ws.ts", timeoutMs: 30_000 },
  { file: "smoke-cancel.ts", timeoutMs: 30_000 },
  { file: "smoke-stage6.ts", timeoutMs: 30_000 },
  // K11.a：原工具名大小写错（"glob"/"grep"）已修为 "Glob"/"Grep"，恢复运行。
  { file: "smoke-stage6-globgrep.ts", timeoutMs: 30_000 },
  // K11.b：原断言 history[0] 是 user，但 7aef1eb 起 history[0] 是 system；
  // 已改为 history.find(role==="user")，恢复运行。
  { file: "smoke-stage7.ts", timeoutMs: 30_000 },
  { file: "smoke-usage-model.ts", timeoutMs: 30_000 },
  // 老 smoke 验证 system_prompt 下拉路径 —— Phase G 默认走 agent 路径会
  // 隐藏 system_prompt 下拉。用 INVOX_AGENTS=disabled 保留旧场景以保证回归。
  {
    file: "smoke-config-options.ts",
    timeoutMs: 30_000,
    env: { INVOX_AGENTS: "disabled" },
  },
  // Phase G：自定义 Agent 模板下拉端到端验证
  { file: "smoke-agents.ts", timeoutMs: 30_000 },
  { file: "smoke-hooks-protocol.ts", timeoutMs: 45_000 },
  // .mjs 但 import 的是 src/tools/fs-utils.js（NodeNext 风格）—— 必须走 tsx
  // 才能把 .js 解析到 .ts 源码，裸 node 解析失败。
  { file: "smoke-fspath.mjs", timeoutMs: 15_000 },
  // 真实 LLM 调用：缺 env 时 smoke 自身 SKIP；跑得慢，60s
  { file: "smoke-openai.ts", timeoutMs: 60_000 },
  // 需要外部 ECOMarket 路径，没设环境变量就跳过
  {
    file: "smoke-plugin-real.ts",
    timeoutMs: 30_000,
    skipIf: () => !process.env["INVOX_TEST_ECOMARKET_DIR"],
    skipReason: "INVOX_TEST_ECOMARKET_DIR not set",
  },
];

// ── 实际 cases ─────────────────────────────────────────────────────

describe("integration: examples/smoke-*", () => {
  for (const sc of SMOKES) {
    const skip = sc.skipIf?.() ?? false;
    const fn = skip ? it.skip : it;
    fn(
      `${sc.file}${skip ? ` (SKIP: ${sc.skipReason})` : ""}`,
      async () => {
        // 所有 smoke 统一用 tsx 跑 —— 包括 .mjs：smoke-fspath.mjs 通过 .js 后缀
        // import .ts 源码，裸 node 解析不到。tsx 既能跑 .ts 也能跑 .mjs。
        const r = await runSmoke(sc.file, {
          timeoutMs: sc.timeoutMs,
          env: sc.env,
        });
        expectPass(r, sc.file);
      },
      sc.timeoutMs ?? 45_000,
    );
  }
});
