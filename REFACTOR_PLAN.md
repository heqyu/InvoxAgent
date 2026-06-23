# Invox 重构计划（Phase J）

> **生成时间**：2026-06-23
> **基于**：一次完整 codebase review（详见会话历史）
> **执行原则**：完全沿用本工程已有节奏 —— PLAN.md Rule 2/5/6（外部证据驱动）+ PROGRESS.md 的 Phase/Stage 编排 + 单 commit 一个 stage + `[VERIFIED]` 标签。
>
> **agent 执行须知**（必读）：
> 1. 本文件是"宪法补充"。冲突顺序仍是 **PLAN > PROGRESS > 本文件 > 代码**。
>    如果本计划与 PLAN.md/PROGRESS.md 的红线冲突 → **先停下来更新 PLAN/PROGRESS，再继续**。
> 2. 每个 Stage 必须**独立可验收**：跑 `npm run typecheck && npm test`，必要时跑相关 smoke。
> 3. **不允许跨 Stage 提交**。一个 Stage 一次 commit，commit message 格式见 §0.3。
> 4. **不允许在大文件持续堆代码**。每个 Stage 完成时必须满足"行数预算"（见 §0.4），
>    否则本 Stage 不算完，必须就地拆分。
> 5. 任何 Stage 跑挂了 → `git reset --hard <last-VERIFIED>` 后重做，**绝不在坏代码上贴补丁**。
> 6. **不要主动改 prompt 文案 / agent 业务行为**。本计划是结构重构，不是功能改动。
>    Worker/Plan/Ask/CodeReviewer/BDD 的 prompt 文字、Bash 工具的 rtk 集成行为、
>    工具签名、ACP 协议表面，**逐字节保持**。如果某次重构发现不得不动行为，
>    必须先开一个 ❓ Stage 让用户确认，不许擅自改动。
> 7. 本计划假定起点是 `main` 分支已包含的 v0.0.1 + Phase G/H/I/I.5 全部 [VERIFIED] 状态。

---

## 0. 总则

### 0.1 目标

把 review 出的**结构性债务**一次性清掉，让代码进入"再加 3-5 个 feature 也不需要大拆"的可持续状态。本次**不引入新功能**，只做：

- 拆大文件（>= 500 行的文件全部回到 ≤ 400 行）
- 消除重复（hook 加载器、log 文件、SubAgentRunResult 类型等）
- 理顺职责（router vs prompt-loop、Session 工厂、SystemPromptComposer）
- 把"隐藏行为"暴露成可配置（rtk rewrite → hook）
- 把已暴露的小坑收掉（disk-scan 找不到 cwd、cli.ts 顺序反直觉、tool spec dynamic/static 漂移）

### 0.2 范围 / 非范围

| | 范围 | 非范围 |
|---|---|---|
| **改** | 文件位置、文件拆分、类型定义、内部 API | ACP 协议表面、工具语义、prompt 文案 |
| **加** | Session 工厂、SystemPromptComposer、新模块目录 | 新工具、新 agent 模板、新 transport |
| **删** | 重复代码、shim 文件、过设计的状态机 | 任何已有 feature |
| **碰** | 单元测试（按需补） | smoke-*.ts（仅在调用路径变化时改 import；行为断言保持不变） |

### 0.3 Commit 信息约定

复用 PROGRESS.md §6.2：

```
refactor(J<stage-id>): <短描述>

<可选 body：解释这次拆分把哪些行 / 哪些重复 / 哪种坏味道消掉了>
<可选 body：跑过的验证命令（npm test 多少通过，smoke 跑了哪些）>

[J<stage-id>]
```

每个 Stage commit 末尾必须有 `[J<stage-id>]`（如 `[J1]`、`[J2.3]`），便于 git log 检索。
**本计划不要求 `[VERIFIED]` 标签** —— `[VERIFIED]` 是 PLAN.md 留给"协议表面 stage"的，本计划不动协议。

### 0.4 行数预算（每 Stage 完工必须满足）

| 文件 | 上限 | 当前 |
|---|---|---|
| `src/agent/agent.ts` | **≤ 400** | 1056 |
| `src/agent/templates.ts` | 删除（拆为目录） | 1025 |
| `src/agent/templates/*.ts` 各 | ≤ 300 | — |
| `src/agent/sub-agent/*.ts` 各 | ≤ 300 | 745 (sub-agent-runner.ts) |
| `src/plugins/hooks.ts` | ≤ 500 | 762 |
| `src/cli.ts` | ≤ 400 | 557 |
| 其它新建文件 | ≤ 400 | — |

行数包含注释。**不准用"砍注释凑数字"逃避**——注释是这个工程的重要资产。
如果某 Stage 完成后超预算，说明拆分粒度不对，**必须就地再拆**。

### 0.5 全局测试 / 静态检查

每个 Stage 完成后**必须全跑**：

```bash
npm run typecheck        # 必须 0 error
npm test                 # 必须 240+ passed / 0 failed（允许 skip 数与之前一致）
```

涉及对应模块时**附加**跑相关 smoke：

```bash
# 改了 prompt-loop / tool 调度 → 跑工具相关 smoke
npx tsx examples/smoke-tools.ts
npx tsx examples/smoke-stage6-globgrep.ts
# 改了 agent / config-options → 跑 agents smoke
npx tsx examples/smoke-agents.ts
# 改了 sub-agent → 跑 sub-agent smoke
npx tsx examples/smoke-subagent.ts    # 如不存在，需新建（见 J2.4）
# 改了 transports → 跑 ws / cancel
npx tsx examples/smoke-ws.ts
npx tsx examples/smoke-cancel.ts
```

### 0.6 失败回滚协议

任一 Stage 进入下列任一状态 → 立即 `git reset --hard <last-stage-commit>` 重做：

1. typecheck 失败超过 30 分钟仍没修好
2. npm test 出现新的 failed（非 skip）
3. 任何 smoke 从 PASS 变 FAIL
4. 发现需要修改 PLAN.md / 协议表面才能继续

回滚后在 DIARY.md 追加一段"为什么栽了 + 下次怎么躲"。

---

## 1. Phase J 路线图（共 4 个子 Phase，14 个 Stage）

```
J1  类型 & 工厂层      （3 Stage，1 天）
J2  大文件拆分          （5 Stage，3-4 天）
J3  职责理顺 & 去重     （4 Stage，2 天）
J4  收尾小修            （2 Stage，半天）

总：14 Stage，预计 6-7 工作日
```

### Phase J1 — 类型 & 工厂层（地基）

> 进入条件：当前 main 分支 typecheck + test 全绿。
> 退出条件：所有后续 Stage 引用的"基础设施"就绪。

| ID | 任务 | 行数变化 | 风险 |
|---|---|---|---|
| J1.1 | Session 工厂：`src/agent/session-factory.ts` | +90 / 改 3 处构造点 | 低 |
| J1.2 | 统一 `SubAgentRunResult` 类型（消除两份定义） | -约 30 | 低 |
| J1.3 | 统一日志文件 helper（`openSubAgentLog` 合并进 `log.ts:openSessionLogFile`） | -约 50 | 中（同步 fd 行为要测） |

### Phase J2 — 大文件拆分

> 进入条件：J1 全部 done。
> 退出条件：`templates.ts` / `sub-agent-runner.ts` / `agent.ts` / `hooks.ts` 全部回到行数预算。

| ID | 任务 | 行数变化 | 风险 |
|---|---|---|---|
| J2.1 | `templates.ts` 拆 `src/agent/templates/` 目录 | -1025 / +约 7 文件各 ≤ 300 | 中 |
| J2.2 | `sub-agent-runner.ts` 拆 `src/agent/sub-agent/` 目录 | -745 / +约 5 文件各 ≤ 300 | 中 |
| J2.3 | `hooks.ts` 合并 `mergeSettingsHooks` + `loadHooksFromPlugin` | -约 100 | 低 |
| J2.4 | `agent.ts` collaborator 拆分（`SessionLifecycle` / `ConfigRouter` / `PromptOrchestrator`） | -约 650 / +3 文件 | **高** |
| J2.5 | `cli.ts` 抽 `loadJsonArray<T>` + 收尾 | -约 70 | 低 |

### Phase J3 — 职责理顺 & 去重

| ID | 任务 | 行数变化 | 风险 |
|---|---|---|---|
| J3.1 | `tools/router.ts` 与 `prompt-loop.ts` 职责切分（方案 A） | -约 20 | 中 |
| J3.2 | `SystemPromptComposer`：history[0] 构造单点化 | -约 30 | 中 |
| J3.3 | `SessionConfigMode` 决策集中化（agent vs system_prompt） | -约 40 | 低 |
| J3.4 | `applyAgentModel` 对称化（newSession / loadSession / set-config 三路） | +少量 | 低（行为修正） |

### Phase J4 — 收尾小修

| ID | 任务 | 行数变化 | 风险 |
|---|---|---|---|
| J4.1 | `bash.ts` 的 rtk-rewrite 改 `INVOX_BASH_NO_RTK` 开关 + 文档化（hook 化推到 Backlog） | -约 40 | 低 |
| J4.2 | 杂项收尾：cli.ts 顺序、disk-scan cwd、SubAgent dynamic spec 兜底、context_limit 错误分类 | +少量 | 低 |

---

## 2. 详细 Stage 规范

### 2.1 Stage J1.1 — Session 工厂

**意图**：消除 `agent.ts:234-248` (newSession) / `agent.ts:361-384` (loadSession) / `sub-agent-runner.ts:389-411` 三处 `Session` 构造的重复，避免新增字段时漏改。

**改动**：

1. 新建 `src/agent/session-factory.ts`：

   ```ts
   import { randomUUID } from "node:crypto";
   import { FileCache } from "../tools/cache.js";
   import type { HookRegistry } from "../plugins/hooks.js";
   import type { McpClientManager } from "../mcp/client.js";
   import type { LLMMessage } from "../llm/types.js";
   import type { Session, PersistedTurnUsage } from "./session-types.js";
   import type { LogFile } from "../log.js";
   import { emptyTurnUsage } from "./usage-meter.js";

   export interface SessionInitOptions {
     /** 不传则 randomUUID()；loadSession / sub-agent 显式传入。 */
     id?: string;
     cwd: string;
     history: LLMMessage[];
     /** subagent 必传（父的）；newSession / loadSession 由 caller 调 loadHooks 后传入。 */
     hooks: HookRegistry;
     /** subagent 复用父的；其它路径走 initMcpForSession 异步设置（不在工厂里）。 */
     mcpClient?: McpClientManager;
     selectedModel?: string;
     configValues?: Record<string, string>;
     createdAt?: number;
     lastTurnUsage?: PersistedTurnUsage;
     sessionLog?: LogFile;
   }

   /**
    * 唯一 Session 构造点。新增字段时只改这里。
    * 注意：mcpClient / sessionLog 在 newSession / loadSession 路径上由 caller
    * **异步**填充（initMcpForSession / openSessionLogFile）；工厂只接收预先准备
    * 好的引用或留空。
    */
   export function createSession(opts: SessionInitOptions): Session {
     return {
       id: opts.id ?? randomUUID(),
       cwd: opts.cwd,
       history: opts.history,
       abort: new AbortController(),
       toolState: { readPaths: new Set<string>(), cache: new FileCache() },
       createdAt: opts.createdAt ?? Date.now(),
       configValues: opts.configValues ?? {},
       turnUsage: emptyTurnUsage(),
       turnStartedAt: 0,
       hooks: opts.hooks,
       ...(opts.selectedModel ? { selectedModel: opts.selectedModel } : {}),
       ...(opts.mcpClient ? { mcpClient: opts.mcpClient } : {}),
       ...(opts.lastTurnUsage ? { lastTurnUsage: opts.lastTurnUsage } : {}),
       ...(opts.sessionLog ? { sessionLog: opts.sessionLog } : {}),
     };
   }
   ```

2. `agent.ts:newSession` 第 234-248 行改为：
   ```ts
   const session = createSession({
     cwd: params.cwd,
     history: [systemMessageWithMemoryAndSkills(promptBody, params.cwd)],
     hooks: loadHooks(params.cwd),
     configValues: initialConfigValues,
   });
   ```

3. `agent.ts:loadSession` 第 361-384 行同理改为 `createSession({ id: snapshot.id, ... })`。

4. `sub-agent-runner.ts:389-411` 改为：
   ```ts
   const sub = createSession({
     id: parent.id,                       // 共享父 id（详见原注释 391-393）
     cwd: parent.cwd,
     history: [...],
     hooks: parent.hooks,                 // 共享 hooks
     mcpClient: parent.mcpClient,         // 共享 MCP
     selectedModel: resolvedModel,
     configValues: { thinking: parent.configValues["thinking"] ?? "off" },
   });
   sub.abort = subAbort;                  // 工厂创了一个新的，立刻替换为联动版
   sub.turnStartedAt = Date.now();
   ```
   注意：sub-agent 需要的 `subAbort`（联动父 abort + signal）的特殊性让它**不**完全适配工厂模式 ——
   工厂出来后 caller 立刻覆盖 `sub.abort`。这是预期的小妥协，加注释说明即可。

**新增测试**：`tests/unit/session-factory.test.ts`

- case 1：`createSession({ cwd, history, hooks })` 默认字段齐全（abort 是新 AbortController、turnUsage 空、readPaths 空 Set 等）
- case 2：可选字段（mcpClient / selectedModel / lastTurnUsage / sessionLog）传与不传的双向对称
- case 3：不传 id 时自动生成 UUID v4 格式

**验收**：
- typecheck 0 error
- `npm test` 通过（应当 +3 case）
- 通读 `agent.ts` / `sub-agent-runner.ts`，确认无任何**保留的** `new AbortController()` / `new FileCache()` / `emptyTurnUsage()` 出现在 Session 构造场景外
- commit message：`refactor(J1.1): unify Session construction via createSession factory [J1.1]`

---

### 2.2 Stage J1.2 — 统一 `SubAgentRunResult` 类型

**意图**：`src/tools/types.ts:57-90` 与 `src/agent/sub-agent-runner.ts:74-92` 各定义一份，字段已经接近但仍可能漂移。**让 `src/agent/sub-agent-runner.ts` 作为权威定义**（它知道所有字段语义），`tools/types.ts` re-export。

**改动**：

1. `src/agent/sub-agent-runner.ts` 中现有 `SubAgentRunResult` 已经是完整版（含 logPath / progressLines / error），保留。
2. `src/tools/types.ts` 删除 line 57-90 的 `SubAgentRunResult` 定义，改为：
   ```ts
   // SubAgentRunResult 的权威定义在 src/agent/sub-agent-runner.ts。
   // 这里 re-export 让工具子系统使用，避免循环依赖请用 import type。
   export type { SubAgentRunResult } from "../agent/sub-agent-runner.js";
   ```
3. **检查**：`SubAgentRunner` 类型签名（`tools/types.ts:92-95`）仍引用 `SubAgentRunResult`，类型导入路径变更后 typecheck 必须仍绿。

**注意**：`tools/types.ts` 反向 import `agent/sub-agent-runner.ts` 不会产生**值**循环依赖（用 `import type`，被 TS 完全 erase）。但**类型循环**仍要小心：`sub-agent-runner.ts` 不允许从 `tools/types.ts` import 任何**值**，只能 `import type`。当前 sub-agent-runner.ts 只 import `tools/cache.js`（值），符合要求。

**验收**：
- typecheck 0 error
- 全局 grep 验证没有第二份 `interface SubAgentRunResult` 残留：
  ```bash
  grep -rn "interface SubAgentRunResult" src/ tests/
  # 期望：仅 src/agent/sub-agent-runner.ts 一处
  ```
- commit：`refactor(J1.2): single source of truth for SubAgentRunResult type [J1.2]`

---

### 2.3 Stage J1.3 — 统一日志文件 helper

**意图**：`log.ts:openSessionLogFile`（241-292）与 `sub-agent-runner.ts:openSubAgentLog`（130-192）是两份功能高度重复的同步 fd 写入器。合并为一份。

**改动**：

1. `src/log.ts` 修改 `openSessionLogFile`，新增可选参数：
   ```ts
   export interface SessionLogOptions {
     /** 子目录名（默认 "logs"，subagent 也用 "logs"）。 */
     subdir?: string;
     /** 文件名生成器；接收 sanitize 过的 base name，返回完整文件名（不含 .log 后缀）。
      *  默认 `(base) => base`。subagent 用 `(base) => `subagent-${base}-<run>-<ts>``。 */
     fileNameFn?: (sanitizedBase: string) => string;
   }
   export function openSessionLogFile(
     cwd: string,
     name: string,
     label: string,
     opts?: SessionLogOptions,
   ): LogFile { ... }
   ```
   实现保持同步 fd（openSync/writeSync/closeSync）+ noop 兜底。

2. `sub-agent-runner.ts:openSubAgentLog` 整段**删除**，改用：
   ```ts
   import { openSessionLogFile } from "../log.js";

   const logFile = openSessionLogFile(
     parent.cwd,
     parent.id,
     "subagent",
     {
       fileNameFn: (base) => {
         const safeParent = base.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
         const safeRun = runId.slice(0, 8);
         const ts = new Date().toISOString().replace(/[:.]/g, "-");
         return `subagent-${safeParent}-${safeRun}-${ts}`;
       },
     },
   );
   ```

3. `sub-agent-runner.ts` 顶部的 `import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"` 删除（不再需要）。

4. 同时删除 `sub-agent-runner.ts:605-609` 那份重复的 `preview` 函数，改为 `import { preview } from "../log.js"`（log.ts 已经导出过）。

**新增测试**：`tests/unit/log-file.test.ts`（如已存在则补 case）

- case 1：默认 `openSessionLogFile(cwd, "abc", "session")` 写到 `<cwd>/.invox/logs/abc.log`
- case 2：传 `fileNameFn` 时文件名走自定义路径
- case 3：mkdir 失败时返回 noop（不抛错）

**验收**：
- typecheck 0 error
- npm test 全绿
- `npx tsx examples/smoke-subagent.ts`（或现有 sub-agent 相关 smoke）跑通，确认 subagent 日志文件仍按 `subagent-*-*-*.log` 命名出现在 `.invox/logs/`
- commit：`refactor(J1.3): merge openSubAgentLog into openSessionLogFile [J1.3]`

---

### 2.4 Stage J2.1 — `templates.ts` 拆分

**意图**：1025 行 → 7 个文件，prompt 文本剥到 `.ts` 资源文件（暂不改成 `.md`，保持 dist build 简单；下一次再讨论是否切 `.md`）。

**目标目录**：
```
src/agent/templates/
  index.ts            ← 对外 barrel，re-export
  types.ts            ← AgentTemplate / AgentSource
  filter.ts           ← filterToolSpecsByAgent / agentAllowsMcp
  model-resolver.ts   ← resolveAgentModel / readEnvModelPro / readEnvModelLite + 4 个 env 常量
  loader.ts           ← loadAgentsFromDir / parseAgentFile / isValidAgentId / loadAgentTemplates
  seed.ts             ← seedDefaultAgents + 旧版迁移 isLegacyDefault* helpers
  builtin.ts          ← BUILTIN_AGENTS (只有 Worker) + DEFAULT_USER_AGENTS (Plan/Ask/CodeReviewer/BDD)
  prompts/
    worker.ts         ← export const WORKER_PROMPT = `...`
    plan.ts
    ask.ts
    code-reviewer.ts
    bdd.ts
```

**改动顺序**（必须严格按这个顺序，每步独立可 typecheck）：

1. **创建 `prompts/*.ts`**：把 `templates.ts` 中 5 段 prompt 字面量原样剪切过去，每文件一个 export。
   - `WORKER_PROMPT` 来自 templates.ts:91-164
   - `PLAN_PROMPT` 来自 templates.ts:196-229
   - `ASK_PROMPT` 来自 templates.ts:239-259
   - `CODE_REVIEWER_PROMPT` 来自 templates.ts:271-322
   - `BDD_PROMPT` 来自 templates.ts:337-523
   - **逐字节复制**，绝不修改 prompt 内容
2. **创建 `builtin.ts`**：把 `BUILTIN_AGENTS` (166-177) 和 `DEFAULT_USER_AGENTS` (190-528) 搬过来，
   prompt 字段改为 import 自 `prompts/*.ts`。
3. **创建 `types.ts`**：把 `AgentSource` + `AgentTemplate` (56-68) 搬过来。
4. **创建 `model-resolver.ts`**：把 940-1025 搬过来（4 个 env 常量 + 2 个 readEnvModel* + resolveAgentModel）。
5. **创建 `filter.ts`**：把 852-923 搬过来（filterToolSpecsByAgent + agentAllowsMcp）。
6. **创建 `loader.ts`**：把 668-833 搬过来（loadAgentsFromDir + isValidAgentId + parseAgentFile + loadAgentTemplates）。
   - 注意：`loadAgentTemplates` 调 `seedDefaultAgents()`，需要 import 自 seed.ts
   - 也需要 import `BUILTIN_AGENTS` from builtin.ts
7. **创建 `seed.ts`**：把 530-664 搬过来（isLegacyDefault* + seedDefaultAgents）。
   - 需要 import `DEFAULT_USER_AGENTS` from builtin.ts
8. **创建 `index.ts`**（barrel）：
   ```ts
   export type { AgentTemplate, AgentSource } from "./types.js";
   export { BUILTIN_AGENTS } from "./builtin.js";
   export { filterToolSpecsByAgent, agentAllowsMcp } from "./filter.js";
   export {
     resolveAgentModel,
     readEnvModelPro,
     readEnvModelLite,
     MODEL_PRO_ENV_PRIMARY,
     MODEL_LITE_ENV_PRIMARY,
     MODEL_PRO_ENV_ALIAS,
     MODEL_LITE_ENV_ALIAS,
   } from "./model-resolver.js";
   export { loadAgentTemplates } from "./loader.js";
   ```
9. **删除旧 `src/agent/templates.ts`**（git rm）。
10. **修正所有 import**：全局搜 `from "./templates.js"` / `from "../agent/templates.js"`，
    一律改成 `from "./templates/index.js"` / `from "../agent/templates/index.js"`。
    NodeNext 解析下，`from ".../templates.js"` 不会自动找到 `templates/index.js`，**必须显式写 `/index.js`**。

11. **简化 seed `action` 状态机**（review §3.4，附带收益）：保留逻辑但把 6 态 enum 改成 `{ shouldWrite: boolean; reason: string }` 二元组。**仅做内部简化，写盘行为不变**，便于后续删除迁移代码。

**验收**：
- typecheck 0 error
- npm test 全绿（agent-templates.test.ts 的 51 case 必须 0 失败）
- `npx tsx examples/smoke-agents.ts` PASS
- 每个新文件 ≤ 300 行
- 全局 grep：
  ```bash
  grep -rn "from \".*templates\.js\"" src/   # 期望：全部指向 templates/index.js
  grep -rn "WORKER_PROMPT\|PLAN_PROMPT\|ASK_PROMPT\|CODE_REVIEWER_PROMPT\|BDD_PROMPT" src/
  # 期望：仅 prompts/*.ts 定义、builtin.ts 引用
  ```
- commit：`refactor(J2.1): split templates.ts into templates/ directory [J2.1]`

---

### 2.5 Stage J2.2 — `sub-agent-runner.ts` 拆分

**意图**：745 行 → 5 个文件。

**目标目录**：
```
src/agent/sub-agent/
  index.ts            ← runSubAgent 主入口 + SubAgentDeps/Options/Result 类型
  conn-wrapper.ts     ← wrapConnForSubAgent + shouldLogNotif + summarizeNotif
  progress-emitter.ts ← makeProgressEmitter + ProgressEmitter interface
  banner.ts           ← buildSubAgentBanner
  iterations.ts       ← subAgentMaxIterations + lastAssistantText + collectAssistantText 等小 helper
```

**改动顺序**：

1. **创建 `banner.ts`**：搬 sub-agent-runner.ts:289-313（`buildSubAgentBanner`）。
2. **创建 `progress-emitter.ts`**：搬 200-278（`ProgressEmitter` interface + `makeProgressEmitter`）。
3. **创建 `conn-wrapper.ts`**：搬 600-745（`summarizeNotif` + `shouldLogNotif` + `wrapConnForSubAgent` + 用到的本地 `preview` 函数 —— 但优先改成 import `preview` from `../../log.js`）。
4. **创建 `iterations.ts`**：搬 100-114（`SUBAGENT_MAX_ITERATIONS_FALLBACK` + `subAgentMaxIterations`），以及 571-599（`lastAssistantText` + `collectAssistantText`），以及 196-198（`ts` 时间戳 helper）。
5. **创建 `index.ts`**：保留 `SubAgentDeps` / `SubAgentRunOptions` / `SubAgentRunResult` 类型 + `runSubAgent` 主体（30-545）。其它都 import 进来。
6. **删除旧 `src/agent/sub-agent-runner.ts`**。
7. **修正所有 import**：
   ```bash
   grep -rn "sub-agent-runner" src/ tests/
   # 全部改为 "sub-agent/index.js"
   ```
   主要影响：`prompt-loop.ts:597` 的 `await import("./sub-agent-runner.js")` → `await import("./sub-agent/index.js")`；
   `tools/sub-agent.ts:138` 的 `import { buildSubAgentBanner } from "../agent/sub-agent-runner.js"`
   → `from "../agent/sub-agent/banner.js"`（直接走具体子模块，不要走 barrel —— banner 与 runner 没有逻辑依赖，分开 import 减少循环依赖风险）。

**注意**：`tools/sub-agent.ts` import `buildSubAgentBanner` 时**绕开 index.ts**，避免循环依赖（tools → agent/sub-agent/index → tools 的潜在环）。具体走 `banner.ts` 子模块。

**验收**：
- typecheck 0 error
- `npm test` 全绿（sub-agent-runner.test.ts 的 15+ case 必须 0 失败）
- `npx tsx examples/smoke-subagent.ts` PASS（如不存在，参考 tests/integration/smoke.test.ts 找一个最近的 sub-agent 测试用例）
- 每个新文件 ≤ 300 行
- commit：`refactor(J2.2): split sub-agent-runner.ts into sub-agent/ directory [J2.2]`

---

### 2.6 Stage J2.3 — `hooks.ts` 合并加载器

**意图**：删 `mergeSettingsHooks`（255-306）与 `loadHooksFromPlugin`（310-389）的重复。

**改动**：

1. 抽 `parseHookGroup(group: unknown): { matcher?, description?, hooks: HookCommand[] } | null`
   ——只做单组校验和归一化，不接触 registry。
2. 抽 `mergeHookGroupMap(groups, registry, source)`：
   ```ts
   interface HookSource {
     kind: "settings" | "plugin";
     label: string;      // "user settings" / "project settings" / pluginName
     pluginRoot?: string; // 仅 plugin
   }
   function mergeHookGroupMap(
     groups: Record<string, unknown>,
     registry: HookRegistry,
     source: HookSource,
   ): void { ... }
   ```
3. `mergeSettingsHooks` 改为薄壳：调 `mergeHookGroupMap(settingsHooks, registry, { kind: "settings", label: source })`。
4. `loadHooksFromPlugin` 改为薄壳：读完 JSON 后调 `mergeHookGroupMap(hooks, registry, { kind: "plugin", label: pluginName, pluginRoot })`。
5. 删除函数体内的第二份 `registryMap` 定义（333-340）；统一用文件顶部那个 `registryMap` 函数（233-244）。
6. 文件最终行数应 ≤ 600（仍超 500 预算，但 hook 系统类型定义 + 6 个 runner 函数本来就量大；如最终仍 > 500，**进一步**把 `runHookCommand`+`runHooks` 移到 `src/plugins/hooks-runner.ts`，类型 + matcher 留在 `hooks.ts`）。

**新增测试**：`tests/unit/hooks.test.ts`（已有，**补**）

- case：同一组 hook group（matcher + 多个 command）在 settings.json 和 plugin/hooks.json 中合并的结果是 superset
- case：异常 entries 跳过但不影响合法 entries

**验收**：
- typecheck + npm test 全绿
- 行数：`hooks.ts` ≤ 500 或 ≤ 600（若拆出 hooks-runner.ts 则前者）
- 全局 grep：
  ```bash
  grep -rn "mergeSettingsHooks\|loadHooksFromPlugin" src/
  # 期望：两者作为薄壳函数仍存在；mergeHookGroupMap 唯一干活
  ```
- commit：`refactor(J2.3): collapse settings/plugin hook loaders into shared mergeHookGroupMap [J2.3]`

---

### 2.7 Stage J2.4 — `agent.ts` collaborator 拆分（**本计划最大改动，分多个小步**）

**意图**：1056 行 → ≤ 400 行。把 `InvoxAgent` 拆成 ACP entry dispatcher + 3 个 collaborator。

> ⚠️ **本 Stage 风险最高**。`InvoxAgent.prompt()` 是核心循环，任何顺序错位都会让既有 240+ 测试与 smoke 红一片。
> 建议**分 4 个 sub-commit**（J2.4a → J2.4d），每个 sub-commit 单独跑全测。

#### J2.4a — 抽 `SessionLifecycle`

新建 `src/agent/session-lifecycle.ts`，承担：

- `newSession` 业务（不含 ACP 入参解析）
- `loadSession` 业务（不含 ACP 入参解析）
- `unstable_deleteSession` 中"清场"动作（abort + releaseSessionMcp + SessionStore.delete + sessionLog.close）
- `persist(session)`
- `maybeSyncZedThreads`（agent 生命周期内只跑一次）
- `sendAvailableCommands`

`InvoxAgent` 持有一个 `private lifecycle: SessionLifecycle` 实例，ACP 方法调它。

签名草图：
```ts
class SessionLifecycle {
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly configs: AgentConfigOptions,
    private readonly models: AgentModelConfig,
    private readonly composer: SystemPromptComposer,   // J3.2 才有；本 sub-commit 先用 systemMessageWithMemoryAndSkills 直接调用
  ) {}
  async createSession(cwd: string, initialConfigValues: Record<string, string>): Promise<Session>
  async restoreSession(cwd: string, sessionId: string, restoredConfigValues): Promise<Session>
  async destroy(session: Session): Promise<void>
  persist(session: Session): void
  async maybeSyncZedThreads(cwd: string): Promise<void>
  async sendAvailableCommands(session: Session): Promise<void>
}
```

**注意**：J2.4a **不引入** SystemPromptComposer（那是 J3.2）；先用直接调用 systemMessageWithMemoryAndSkills 跑通，等 J3.2 再切换。

**验收**：测试全绿；`agent.ts` ≤ 700 行（中间态）；commit `refactor(J2.4a): extract SessionLifecycle [J2.4a]`

#### J2.4b — 抽 `ConfigRouter`

新建 `src/agent/config-router.ts`，承担 `setSessionConfigOption` 的 4 个分支（model / agent / system_prompt / thinking），以及 `effectiveSystemPromptBody` / `applyAgentModel` / `activeAgentFor` 这些私有 helper。

签名草图：
```ts
class ConfigRouter {
  constructor(
    private readonly configs: AgentConfigOptions,
    private readonly models: AgentModelConfig,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
    private readonly systemPromptById: ReadonlyMap<string, SystemPromptDef>,
    private readonly availableModelIds: Set<string>,   // 注意：会被 applyAgentModel 动态 add
  ) {}
  applyConfigChange(session: Session, configId: string, value: string): void
  effectiveSystemPromptBody(configValues: Record<string, string>): string
  applyAgentModel(session: Session, agent: AgentTemplate): void
  activeAgentFor(session: Session): AgentTemplate | undefined
}
```

`agent.ts:setSessionConfigOption` 改为薄壳：参数校验 + 调 `router.applyConfigChange` + persist + 返回 buildConfigOptions。

**验收**：commit `refactor(J2.4b): extract ConfigRouter [J2.4b]`

#### J2.4c — 抽 `PromptOrchestrator`

新建 `src/agent/prompt-orchestrator.ts`，承担 `prompt()` 主循环（agent.ts:619-818）：

- UserPromptSubmit hook
- iter 循环
- Stop hook 重入逻辑
- 顶层 try/catch → refusal 兜底
- finally → reportTurnUsage + persist + 日志收尾

签名草图：
```ts
class PromptOrchestrator {
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly provider: LLMProvider,
    private readonly policy: PermissionPolicy,
    private readonly clientCaps: ClientCapabilities,
    private readonly models: AgentModelConfig,
    private readonly router: ConfigRouter,         // 取 activeAgent
    private readonly lifecycle: SessionLifecycle,  // 取 persist
    private readonly hookBaseFactory: (s: Session) => HookBase,
    private readonly agentById: ReadonlyMap<string, AgentTemplate>,
  ) {}
  async run(session: Session, prompt: PromptRequest): Promise<PromptResponse>
}
```

**验收**：commit `refactor(J2.4c): extract PromptOrchestrator [J2.4c]`

#### J2.4d — 收紧 `InvoxAgent`

`agent.ts` 此时应当只剩：
- 构造器（注入 3 个 collaborator）
- `initialize` / `authenticate` / `cancel`
- `newSession` / `loadSession` / `unstable_deleteSession` / `setSessionConfigOption` / `prompt` —— 全是 1-3 行壳函数，调对应 collaborator
- `hookBase(session)` 构造（保留）

最终行数 **≤ 400**。

跑全套 smoke：
```bash
npx tsx examples/smoke-stdio.ts
npx tsx examples/smoke-tools.ts
npx tsx examples/smoke-ws.ts
npx tsx examples/smoke-cancel.ts
npx tsx examples/smoke-agents.ts
npx tsx examples/smoke-usage-model.ts
npx tsx examples/smoke-config-options.ts
npx tsx examples/smoke-bad-json.ts
npx tsx examples/smoke-error-mapping.ts
# + 任何 sub-agent 相关 smoke
```

全部 PASS 才能 commit。

**验收**：commit `refactor(J2.4d): InvoxAgent reduced to ACP dispatcher (~380 lines) [J2.4d]`

---

### 2.8 Stage J2.5 — `cli.ts` 收尾

**意图**：557 → ≤ 400。`loadPromptTemplates`（489-549）和 `templates/loader.ts:loadAgentsFromDir` 结构同型，抽通用工具。

**改动**：

1. 新建 `src/util/load-json-array.ts`：
   ```ts
   export interface JsonArrayLoadOptions<T> {
     filePath: string;
     /** 必填：把单个 entry 校验并归一化成 T，校验失败返回 null（跳过）。 */
     validate: (entry: unknown, index: number) => T | null;
     /** 文件不存在/解析失败/空数组时的兜底值。 */
     fallback: T[];
     /** log scope，用于 log.warn。 */
     logScope: string;
   }
   export function loadJsonArray<T>(opts: JsonArrayLoadOptions<T>): T[] { ... }
   ```
2. `cli.ts:loadPromptTemplates` 改为 1 个 `loadJsonArray` 调用 + validator 闭包。
3. **额外修复**（review §3.1）：把 `cli.ts:208-238` 中 `shutdownAndExit` 的 const 定义**移到** stdin handler 之前，消除前向引用看起来反直觉的问题。
4. 顺手把 `pickMockProvider`（318-338）/`pickLegacyProvider`（347-359）/`pickLegacyModels`（385-403）/`pickConfigOptions`（424-460）抽到 `src/cli/provider-pick.ts` + `src/cli/config-pick.ts` 两个文件。`cli.ts` 只保留 `main()` + 参数解析。

**验收**：
- typecheck + npm test 全绿
- `cli.ts` ≤ 400 行
- `node dist/cli.js --version` 仍打印 `invox v0.0.1`（重 build 一次）
- `npx tsx examples/smoke-stdio.ts` PASS
- commit：`refactor(J2.5): trim cli.ts + extract loadJsonArray helper [J2.5]`

---

### 2.9 Stage J3.1 — `tools/router.ts` ↔ `prompt-loop.ts` 职责切分

**意图**：消除参数二次解析 + 让权限决策有单一入口。采用**方案 A**：router 改薄壳，参数解析全部交给 prompt-loop。

**改动**：

1. `tools/router.ts:executeTool` 签名改为：
   ```ts
   export async function executeTool(
     name: string,
     args: Record<string, unknown>,    // ← 改为已解析的对象，不再传 rawArgs string
     ctx: ToolExecContext,
   ): Promise<ToolExecResult>
   ```
   函数体删除 `parseToolArguments(rawArgs)` 调用（router.ts:30-34），权限闸门和 `tool.execute` 调用保留。

2. `prompt-loop.ts:runOneToolCall` 第 488 行：
   ```ts
   // 旧：
   : await executeTool(call.name, JSON.stringify(toolArgs), baseExecCtx);
   // 新：
   : await executeTool(call.name, toolArgs, baseExecCtx);
   ```

3. 检查是否还有调用 `executeTool` 的地方：
   ```bash
   grep -rn "executeTool(" src/ tests/
   ```
   `tools/router.ts` 自身和 `prompt-loop.ts` 是仅有的调用方。tests 里如果有调用，对应调整。

**新增测试**：`tests/unit/router.test.ts`（新建）

- case 1：未知工具名返回 errorResult
- case 2：tier=read + policy=writes 不请权限
- case 3：tier=write + policy=writes 请权限，deny 时返回 denied result
- case 4：tier=execute + policy=always 请权限

**验收**：
- typecheck + npm test 全绿
- 全 smoke 全 PASS（特别是 smoke-tools.ts 和 smoke-bad-json.ts —— 这两个最依赖参数解析路径）
- commit：`refactor(J3.1): router takes parsed args; single point of arg parsing in prompt-loop [J3.1]`

---

### 2.10 Stage J3.2 — `SystemPromptComposer`

**意图**：把 history[0] 的构造收敛到一个 collaborator，所有"换 agent / 换 prompt / 换 skill 目录 / loadSession 刷新"路径都走它。

**改动**：

1. 新建 `src/agent/system-prompt-composer.ts`：
   ```ts
   export class SystemPromptComposer {
     constructor(
       private readonly configs: AgentConfigOptions,
       private readonly agentById: ReadonlyMap<string, AgentTemplate>,
       private readonly systemPromptById: ReadonlyMap<string, SystemPromptDef>,
     ) {}

     /** 计算给定 session 当前应当使用的 system message。 */
     computeFor(session: Session): LLMMessage {
       const body = this.effectiveBody(session.configValues);
       return systemMessageWithMemoryAndSkills(body, session.cwd);
     }

     /** 就地刷新 session.history[0]。 */
     refresh(session: Session): void {
       session.history[0] = this.computeFor(session);
     }

     private effectiveBody(configValues: Record<string, string>): string {
       /* 复用 J2.4b ConfigRouter.effectiveSystemPromptBody 的逻辑；
          实际上把 ConfigRouter 上的 effectiveSystemPromptBody 移到这里，
          ConfigRouter 改为依赖 SystemPromptComposer。 */
     }
   }
   ```

2. **改 ConfigRouter**：删 `effectiveSystemPromptBody`，构造时注入 `composer`，`applyConfigChange` 在 agent/system_prompt 分支调 `this.composer.refresh(session)`。

3. **改 SessionLifecycle**：构造 / restore session 时调 `composer.refresh(session)` 一行，取代原来散落的 `systemMessageWithMemoryAndSkills(promptBody, cwd)` 直接调用。

4. **改 PromptOrchestrator**：UserPromptSubmit hook 注入 systemMessage 拼接路径（agent.ts 原 655-666）保持原状（仍直接拼字符串，不走 composer），因为这条路径**只本轮临时拼接**，不应固化到 history[0]。

**新增测试**：`tests/unit/system-prompt-composer.test.ts`

- case 1：agents 模式下 + 不同 configValues.agent → history[0].content 包含对应 agent.prompt
- case 2：system_prompt 模式下（agents 为空） → 走旧路径
- case 3：configValues 引用不存在的 agent id → 回退到 defaultAgentId
- case 4：`refresh()` 不影响 history 其它元素

**验收**：
- typecheck + npm test 全绿
- 全 smoke 全 PASS（重点 smoke-agents.ts / smoke-config-options.ts）
- 全局 grep：
  ```bash
  grep -rn "systemMessageWithMemoryAndSkills" src/
  # 期望：仅 system-prompt-composer.ts 和 system-prompt.ts 自身；
  # SessionLifecycle / ConfigRouter / sub-agent-runner 等都不该再直接调
  ```
  **例外**：sub-agent-runner 的 `systemMessageWithMemoryAndSkills(template.prompt, parent.cwd)` 调用**保留**（subagent 不走 composer，因为它直接拿 template.prompt 而非 configValues），但加注释说明。
- commit：`refactor(J3.2): SystemPromptComposer centralizes history[0] construction [J3.2]`

---

### 2.11 Stage J3.3 — `SessionConfigMode` 决策集中化

**意图**：6 处 `configs.agents.length > 0` 分支判断统一成 `configMode(configs)` 调用。

**改动**：

1. 在 `src/agent/session-types.ts` 加：
   ```ts
   export type SessionConfigMode = "agent" | "system_prompt";

   /** 决定本进程走哪条配置路径。agents 非空 → agent mode；否则旧 system_prompt mode。 */
   export function configMode(configs: AgentConfigOptions): SessionConfigMode {
     return configs.agents.length > 0 ? "agent" : "system_prompt";
   }
   ```

2. 把以下 6 处 `configs.agents.length > 0` 判断**全部**替换为 `configMode(configs) === "agent"`：
   - `SessionLifecycle` (J2.4a 后) 的 newSession 初始 configValues 选择
   - `SessionLifecycle` 的 loadSession 同上
   - `SessionLifecycle` newSession 应用默认 agent.model（原 agent.ts:283-286）
   - `ConfigRouter.applyConfigChange` 的 agent / system_prompt 分支前置检查
   - `SystemPromptComposer.effectiveBody`
   - `config-options.ts:buildConfigOptions` 第 64 行

3. **行为不变**，纯命名/可读性改进。

**验收**：
- typecheck + npm test 全绿
- 全局 grep：
  ```bash
  grep -rn "configs\.agents\.length" src/
  # 期望：0 命中（全部走 configMode）
  ```
- commit：`refactor(J3.3): introduce configMode() to unify agent vs system_prompt decision [J3.3]`

---

### 2.12 Stage J3.4 — `applyAgentModel` 对称化

**意图**：修正 review §2.8 发现的不对称 —— loadSession 路径没有调 applyAgentModel，导致从磁盘恢复时 session.selectedModel 与当前 agent 的 model 字段语义不一致。

**改动**：

1. 在 `SessionLifecycle.restoreSession` 中，**在 `composer.refresh()` 之后**补一段：
   ```ts
   // 与 createSession 对称：如果当前 agent mode 已启用，确保 session.selectedModel
   // 反映当前活跃 agent 的 model 字段（PRO/LITE env 解析后的实际值）。这覆盖了
   // 用户上次保存的 selectedModel 已不在 availableModelIds 里的回退情况。
   if (configMode(this.configs) === "agent") {
     const activeAgent = this.router.activeAgentFor(session);
     if (activeAgent) this.router.applyAgentModel(session, activeAgent);
   }
   ```

2. **新增 smoke**：`examples/smoke-load-session-model.ts`
   - 步骤：
     a. 启动 invox，INVOX_MODEL_LITE=A，INVOX_MODEL_PRO=B，agents 启用，默认 Worker (LITE)
     b. newSession → 验 selectedModel === "A"
     c. setSessionConfigOption(agent="Plan") → 验 selectedModel === "B"
     d. persist → 关掉 invox
     e. 重启 invox，但这次 INVOX_MODEL_PRO=C（B 不在 availableModelIds）
     f. loadSession 同一个 id → 验 selectedModel === "C"（不是 undefined 也不是旧的 "B"）
   - 断言 PASS

**注意**：这是**行为修正**而非纯重构。需要先在 commit message 里写清楚"修正了什么 + 为什么这是正确语义"，必要时同步更新 PROGRESS.md 的 Known Issues。

**验收**：
- typecheck + npm test 全绿
- 新 smoke PASS
- 既有 smoke-agents.ts / smoke-usage-model.ts PASS
- commit：`refactor(J3.4): apply agent.model on loadSession for symmetry [J3.4]`

---

### 2.13 Stage J4.1 — `bash.ts` 的 rtk-rewrite 改可控

**意图**：把"每条 Bash 命令默认走 rtk 改写"这个隐藏行为做成显式开关 + 文档化。

**改动**：

1. `src/tools/bash.ts` 顶部加：
   ```ts
   /** rtk rewrite 集成开关。默认开启；设 INVOX_BASH_NO_RTK=1 关闭。 */
   const RTK_ENABLED = process.env["INVOX_BASH_NO_RTK"] !== "1";
   ```
2. `execute()` 函数中包裹 rtk 调用：
   ```ts
   if (RTK_ENABLED) {
     try {
       const rewritten = await runRtkRewrite(rawCommand, ctx.cwd);
       if (rewritten) { ... }
     } catch (e) { ... }
   }
   ```
3. **更新 README.md** 的 Environment 表，加：
   ```
   | INVOX_BASH_NO_RTK | "1" → 禁用 Bash 工具的 rtk rewrite 集成。默认未设（启用）。 | unset |
   ```
4. **更新 README.md** 的 Tools 表"Bash" 行，加一段说明：
   ```
   > **rtk 集成**：每条命令在执行前会尝试调用本机 `rtk rewrite <cmd>` 做命令改写
   > （需安装 rtk）。rtk 探测失败时静默回退到原始命令。可通过 INVOX_BASH_NO_RTK=1
   > 完全禁用此行为。
   ```
5. **不**做 hook 化（review §2.5 推荐路径），那个改动量大且涉及 hook 协议扩展，留到后续 Phase。本 Stage 仅做"显式化 + 文档化"。在 PROGRESS.md Backlog 加一条："Bash rtk 集成 hook 化"。

**验收**：
- typecheck + npm test 全绿
- `INVOX_BASH_NO_RTK=1 npx tsx examples/smoke-tools.ts` PASS（rtk 路径完全被跳过）
- README 表格行渲染正常
- commit：`refactor(J4.1): expose INVOX_BASH_NO_RTK switch + document rtk rewrite integration [J4.1]`

---

### 2.14 Stage J4.2 — 杂项收尾

**意图**：把 review 的几个小坑一次性收掉。

**改动**（每条改完单独跑一次 typecheck，全 OK 后一次 commit）：

1. **disk-scan cwd**（review §3.3）：在 `SessionLifecycle` 中维护一个进程级 `knownCwds: Set<string>`，每次 createSession/restoreSession 时 `add(cwd)`。`unstable_deleteSession` 的 disk-scan 路径遍历 `[...knownCwds, process.cwd()]`（去重后），不再硬编码 `process.cwd()`。
   - 新增 1 个 unit case：`SessionLifecycle.destroyById(id)` 能命中在另一个 cwd 上 newSession 过的 session。

2. **SubAgent 静态 spec 兜底**（review §3.7）：`tools/sub-agent.ts:140-172` 的静态 `spec` description 中含 `{AGENT_LIST}` 占位符。改为**安全兜底**：把占位符替换为 `"- (Dynamic — refreshed at runtime based on loaded agent templates)\n"`。这样即便某调用路径绕过 `buildDynamicSubAgentSpec`，LLM 看到的也是合法字符串而非 raw placeholder。
   - 加一个 unit case 断言静态 spec.function.description 不含 `{AGENT_LIST}`。

3. **context_limit 错误分类**（review §4.1）：`error-mapping.ts:classifyProviderError` 在 status >= 400 && < 500 的分支前，先检查 message 文本是否匹配：
   ```ts
   const CONTEXT_LIMIT_PATTERNS = [
     /maximum context length is \d+ tokens/i,
     /context.*length.*exceeded/i,
     /tokens.*exceeds.*model.*max/i,
   ];
   ```
   匹配则返回新 category `"context_limit"`，message 写明"上下文超出模型上限。请新建会话或精简 prompt"。
   - 在 `ProviderErrorInfo.category` 联合类型加 `"context_limit"`。
   - 新增 unit case：模拟一条带"maximum context length is 128000 tokens"的 error → 分类为 context_limit。

4. **删 `discovery/claude-md.ts` shim**（如果它真的只是 shim）：
   - 先读 `discovery/claude-md.ts` 全文判断是否真的可以直接删
   - 如可删：全局 grep 引用点，迁到 `discovery/memory-providers.ts`，删 shim
   - 如不可删（有外部依赖路径）：保留并加 `@deprecated` JSDoc

5. **`token-meter.ts` 与 `model-knowledge.ts` 单一来源**（review §3.6）：留到下一 Phase（这条改动需要重新设计 `KNOWN_MODELS` schema，加 alias 字段，影响 multi-provider discovery 的 lookupModelInfo 调用方），**本 Stage 不做**，在 PROGRESS Backlog 加一条。

**验收**：
- typecheck + npm test 全绿
- 全 smoke PASS
- commit：`refactor(J4.2): misc cleanup — known cwds / dynamic spec fallback / context_limit / claude-md shim [J4.2]`

---

## 3. 完成后的状态检查（Done Checklist）

每个 Phase 全部 done 后必须满足：

### J1 完成后
- [ ] `src/agent/session-factory.ts` 存在
- [ ] `SubAgentRunResult` 仅在 sub-agent-runner.ts 定义一次
- [ ] `sub-agent-runner.ts` 不再 `openSync/closeSync` 自己开文件
- [ ] `npm test` ≥ 243 case 全绿

### J2 完成后
- [ ] `agent.ts` ≤ 400 行
- [ ] `templates.ts` 文件**不存在**（被 `templates/` 目录替代）
- [ ] `sub-agent-runner.ts` 文件**不存在**（被 `sub-agent/` 目录替代）
- [ ] `cli.ts` ≤ 400 行
- [ ] `hooks.ts` ≤ 500 行
- [ ] 全 9 个 smoke 全 PASS
- [ ] `npm test` 全绿

### J3 完成后
- [ ] `tools/router.ts` 不再调 `parseToolArguments`
- [ ] history[0] 的所有"构造"调用走 `SystemPromptComposer.refresh()`（subagent 例外，已注释）
- [ ] 全局 grep `configs.agents.length` 0 命中
- [ ] loadSession 与 newSession 对 agent.model 的处理对称（新 smoke 验证）

### J4 完成后
- [ ] README.md 中 `INVOX_BASH_NO_RTK` 已文档化
- [ ] `error-mapping.ts` 支持 `context_limit` category
- [ ] PROGRESS.md 加入 Phase J 的完成记录 + Backlog 更新

---

## 4. 文档同步

完成全部 14 个 Stage 后，**最后**一次 commit：

```
docs(J): update PROGRESS / DIARY / KNOWN_ISSUES after Phase J refactor [J-docs]
```

包含：

1. `PROGRESS.md` 增加 Phase J 段落，14 个 Stage 全部勾上 ✅ + 短描述 + commit hash
2. `PROGRESS.md` Known Issues：K1 标 ✅ Done（agent.ts 终于 ≤ 400）；新增 K13/K14 若 J4.2 第 5 条遗留下来
3. `DIARY.md` 追加 "Sprint J — 还结构性债务" 段落：讲拆分前后对比、踩了哪些坑、下次的教训
4. 如改了协议表面任何东西（理论上不该）→ 同步更新 PLAN.md
5. 更新 README.md 的 `## What it is` 段，如果有"~9300 行 / 56 文件"这类陈旧数字（**有，PROGRESS.md §0 的代码量描述需要更新**）

---

## 5. 不在本计划范围内的事

下列事项**严格不要做**，agent 不准擅自扩展：

- ❌ 修改任何 prompt 文案（Worker / Plan / Ask / CodeReviewer / BDD）
- ❌ 修改任何工具的语义（Read/Write/Edit/Bash/Glob/Grep/Skill/SubAgent/MakePlan）
- ❌ 修改 ACP 协议表面（新方法、新 capabilities、新 sessionUpdate kind）
- ❌ 引入新依赖（package.json 不变）
- ❌ 升级 `@agentclientprotocol/sdk` / `openai` / `vitest` / 任何依赖版本
- ❌ 把 rtk 集成完全拆成 PreToolUse hook（这是后续 Phase 的事）
- ❌ Phase C（历史压缩 / blob 索引 / cache 友好排版）的任何工作
- ❌ Phase D（WS 鉴权 / 路径白名单 / Bash 黑名单）
- ❌ 把 `KNOWN_MODELS` 重构成 alias-aware schema（J4.2 第 5 条明确推到 Backlog）

遇到以上任一项的需求 → **立即停下，开 issue/在会话里问用户**，不要边重构边顺手做。

---

## 6. 给执行 agent 的开工指令模板

下次新会话开始时，把下面这段贴给 agent：

> 请阅读 `g:/OhMyProjs/InvoxAgent/REFACTOR_PLAN.md`，理解 §0 的"执行原则"和 §5 的"严格不要做"清单。
> 然后从 Phase J1 / Stage J1.1 开始执行。
>
> 执行约定：
> 1. 每个 Stage 完成后停下来汇报：跑了哪些命令、行数变化、commit hash；等我确认后再进下一个 Stage。
> 2. 任一 Stage 出现 §0.6 列出的失败信号 → 立即停下汇报，不要自行修补。
> 3. Phase 切换时（J1 → J2 → J3 → J4）暂停一次，等我确认。
> 4. 遵守 §5 的边界 —— 一旦发现某个改动会跨出本计划范围，立即停下问。
>
> 现在请开始执行 Stage J1.1。
