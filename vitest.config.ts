// Vitest 配置 —— Phase A1 落地
//
// 设计点：
// - environment: "node" —— invox 是 Node 进程，不需要 jsdom
// - test.include: 显式扫描 tests/**，不波及 src/
// - test.testTimeout: 60s —— integration smoke 要 spawn 子进程 + 跑 ACP 握手，
//   30s 默认值太紧（特别是冷启动 + tsx 编译）
// - test.hookTimeout: 30s —— beforeAll 里建 tmp 目录 + spawn invox 不应卡
// - resolve.conditions: 不动 —— Node ESM 默认条件即可
//
// vitest 4.x 内置 vite 解析器，对 NodeNext 风格的 ".js" import 自动尝试 ".ts"，
// 因此 src/ 下面互相 import "../foo.js" 在测试里也能解析到 ".ts"。

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // smoke 集成测试要 spawn 多个子进程，在 Windows 上并发会引起 file lock
    // 抖动；并行度收敛到 4 既保留速度也避免抖动。vitest 4 起 maxWorkers /
    // minWorkers 顶层化，旧 poolOptions.threads.* 已废弃。
    pool: "threads",
    maxWorkers: 4,
    minWorkers: 1,
    reporters: ["default"],
    // PROGRESS A1 验收：CI 跑 ≥ 30 个 case
    // （单元 ~54 + integration smoke ~17 = ~71）
  },
});
