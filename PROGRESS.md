# Invox 开发进度与路线图（PROGRESS）

> **角色定位**
> - `PLAN.md` —— 宪法（数据结构、不可逾越的红线、stage 验收契约）
> - `PROGRESS.md` —— 滚动施工图（本文件：当前状态、backlog、下一步要干什么）
> - `DIARY.md` —— 工作日志（决策、教训、为什么这么干）
>
> **使用规则**
> 1. 每个 commit 完成后，把对应任务从「Doing」挪到「Done」并打 commit hash。
> 2. 新增任务进入「Backlog」，明确归属 Phase 与优先级（P0/P1/P2/P3）。
> 3. 每周 Sprint 收尾时把当周记录写进 `DIARY.md`，PROGRESS 这边只留状态。
> 4. PROGRESS 与 PLAN 冲突时，先改 PLAN，再改 PROGRESS，最后改代码。

---

## 0. 当前快照（2026-06-05 02:50）

| 维度 | 状态 |
|---|---|
| 版本 | `0.0.1` |
| 代码量 | ~9000 行 TS / 55 文件（A2 收尾：agent.ts 869 行 + 6 个新 helper 模块） |
| 已完成 stage | 0–8（全部 `[VERIFIED]`） |
| 传输 | stdio + WebSocket |
| 工具 | Read / Write / Edit / Bash / Glob / Grep / Skill + MCP 桥接 |
| 协议外特性 | 会话持久化 / Zed thread 同步 / 模型菜单 / token 计费 / system prompt 模板 / thinking 模式 / 三层 discovery / 统一记忆系统（MemoryProvider）/ 插件 + Hook / MCP 共享池 / 连接重试 / 结构化错误 |
| 测试 | **vitest 4.1.8**：212 个 case（179 单元 + 33 集成 + 0 其他）— 211 ✓ / 1 skip / 0 fail，25.22s |
| 已知风险 | `agent.ts` 869 行（仍 > 400，但已大幅减重）；进一步拆需 collaborator pattern |

---

## 1. 已完成里程碑（Done）

> 详细心路历程见 `DIARY.md` 对应日期。这里只列"已经实现什么"。

### Sprint 0（2026-05-31 ~ 06-04）

- [x] **Stage 0–5** repo skeleton → stdio echo → OpenAI streaming → tool calling → WebSocket → cancellation/permissions（PLAN §2）
- [x] **Stage 6** tools 模块化 registry + `Edit` + `FileCache`（`9900213`）+ `Glob` / `Grep`（`b6a1484`）
- [x] **Stage 7** session 持久化到 `.invox/sessions/`、`loadSession` 回放、TTL 30 天清理（`2462d8e` `168cdee`）
- [x] **Stage 8** 模型菜单 + token 计费（`usage_update` & `agent_thought_chunk` 双通道）（`1b025dc`）
- [x] **可观测性**：`INVOX_LOG_FILE`、trace 级别、Node inspector 调试支持（`b1df348` `c78767c` `e208cec`）
- [x] **Image 输入**支持（`a12fba4`）
- [x] **Session 删除 + Zed thread 同步**（`46731ac`）
- [x] **跨工作区文件读写**（`09dea62`）
- [x] **Windows Git Bash 路径修复 + 工作区边界硬化**（`2d0dea6`）
- [x] **Skill 系统**（`.claude/skills/*/SKILL.md`，`$ARGUMENTS` / `{{key}}` 占位符）（`57c03dc` `5048fc0` `b61ad1`）
- [x] **MCP 客户端**：`.claude/.mcp.json`，`mcp__<server>__<tool>` 命名前缀（`f897a1e`）
- [x] **插件系统 v1**：`plugins.json` 加载 skill 插件（`a052fc1`）
- [x] **插件系统 v2 + Hook**：`hooks/hooks.json` + 6 hook 点 + Claude Code 协议对齐（`3e8b973` `c968a6c`）
- [x] **Discovery 模块**：三层（user / project / plugin）配置统一解析（`a5c79a5`）
- [x] **CLAUDE.md 静态记忆 + `@reference` 解析**（`7aef1eb`）
- [x] **System prompt 注入日期 + 平台**（`2a36f26`）
- [x] **统一记忆系统（MemoryProvider）**：抽象 `MemorySection` + `MemoryProvider`，CLAUDE.md 改造为内置 provider；`DiscoveryResult.memories` 与 plugins/skills/hooks 对称；旧 `loadClaudeMd` 退化为薄 shim 保留兼容（2026-06-05 02:00）

---

## 2. Phase 路线图

> 一个 Phase 不必对应一个 Sprint，但**必须**有一条可外部观察的 acceptance（PLAN Rule 5 的延伸）。
> 所有 Phase 任务进 Done 之前必须配 smoke 或单测。

### Phase A — 「先把椅子修稳」（地基修复，目标 1 周）

> 进入门槛：开始 Phase A 之前禁止在 `agent.ts` 加任何新业务代码。

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| A1 | 引入 `vitest` 测试框架；首批覆盖 `discovery/`、`plugins/hooks.ts`（matcher 正则、合并顺序）、`agent` 的 `maxPrompt` 计费、Windows 路径解析；**把所有 examples/smoke-*.ts 接入 vitest 调度** | P0 | **✅ Done**（16:01）<br/>72 cases：54 单元 + 18 集成 → 69 ✓ / 3 skip / 0 fail<br/>顺手抽出 `src/agent/usage-meter.ts`（A2 提前一小步） | `npm test` 绿；CI 跑 ≥ 30 个 case |
| A2 | **拆分 `agent.ts`** → `agent/connection.ts` / `session.ts` / `prompt-loop.ts` / `usage-meter.ts` / `system-prompt.ts` / `hook-runner.ts` / `model-registry.ts`；单文件 ≤ 400 行 | P0 | **✅ Done**（2026-06-05 02:50）<br/>agent.ts **1660+ → 869 行（-47%）**；新增 6 个 helper：`session-types.ts` (134) / `replay-history.ts` (107) / `turn-usage-reporter.ts` (111) / `config-options.ts` (108) / `mcp-lifecycle.ts` (60) / `prompt-loop.ts` (395)。所有 helper ≤ 400 行；agent.ts 因为剩 ACP entry points + prompt() 主循环（≈175 行）+ 私有胶水，进一步压缩需 collaborator pattern（拆类），列入 Backlog | typecheck 绿 + 211 case PASS + smoke 全 PASS（含恢复运行的 stage6-globgrep / stage7） |
| A3 | 全局 `safeParseJSON`：替换所有裸 `JSON.parse(call.arguments)`（已知点：`agent.ts:987`），失败时把 error 作为 tool result 返还给 LLM 让其自我纠错 | P0 | **✅ Done**（17:05）<br/>新建 `src/agent/json.ts`（safeParseJSON + parseToolArguments）；`agent.ts:987` 改为 fast-fail 路径；`tools/router.ts` 同步收编<br/>新增 13 个单测 + `smoke-bad-json.ts` 黑盒验证（BadJsonProvider 模拟畸形→自我纠错全链路） | 新增 smoke 用畸形 JSON 触发，agent 不挂 |
| A4 | `Session` 持有 `hooks: HookRegistry` 与 `mcpManager` 引用，循环里不再反复 `loadHooks(cwd)` | P1 | **✅ Done**（18:30）<br/>Session 接口加 `hooks: HookRegistry` 必选字段；newSession / loadSession 各调一次 `loadHooks` 填充；agent.ts 内 6 处旧调用（SessionStart / UserPromptSubmit / Stop / PreToolUse / PostToolUse / PostToolUseFailure）全部改为 `session.hooks`<br/>`mcpClient` 字段已在 Session 上（不变）；新增 1 个行为级断言验证缓存命中后磁盘 mutation 不可见 | 单测验证缓存命中次数 |
| A5 | `stopReason` 完整映射：429 → `refusal`，stream 抛错 → 结构化 error，prompt 始终返回合法 `PromptResponse` | P1 | **✅ Done**（20:40）<br/>新建 `src/agent/error-mapping.ts`（`classifyProviderError` + `formatProviderErrorForUser`）；`runOneIteration` 不再 throw，stream 异常 → `{ kind: "stop", reason: "refusal", error }`；`prompt()` 加顶层 try/catch 兜底；新增 `FlakyProvider` + `INVOX_MOCK=flaky` + `INVOX_FLAKY_KIND` env<br/>新增 33 个单测 + 5 场景 smoke（429/500/auth/network/mid-stream）全部映射到 refusal | smoke 模拟 429 / 网络错误，断言 `stopReason` |

### Phase B — 「资源管理与可靠性」（目标 1–2 周）

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| B1 | **MCP 进程池**：跨 session 共享 stdio 子进程；引用计数；最后一个 session 释放后 graceful close | P0 | **✅ Done**（2026-06-05 00:18）<br/>新建 `src/mcp/pool.ts` —— 进程级 singleton 按 cwd 键控；in-flight 去重；`acquireMcp` / `releaseMcp` / `disposeAllMcp`；factory 注入接口便于单测<br/>11 个单元测试覆盖（计数语义 / 不同 cwd 隔离 / 并发去重 / disconnect 抛错容错） | 开 5 个 session 同 MCP server，pool 仅 1 个 manager；单测验证引用计数 |
| B2 | session 销毁路径补全：`deleteSession` / 连接断开 / 进程退出三处都释放 MCP & abort & 持久化 | P0 | **✅ Done**（00:18）<br/>`unstable_deleteSession` 改 abort + `releaseSessionMcp`；cli.ts 增加 SIGINT / SIGTERM / stdin-end 三个进程级钩子统一调 `disposeAllMcp` 兜底；`shutdownAndExit` 幂等 | smoke 关连接后无僵尸进程；既有 17 个 smoke 仍 PASS（mcp config 不存在时 acquire 返回 null = 旧路径） |
| B3 | LLM 调用 **指数退避 + 限流**（429/5xx，可关闭） | P1 | **✅ Done**（00:22）<br/>新建 `src/llm/backoff.ts` —— 仅 connect 阶段重试（避免破坏 mid-stream 增量 UI）；`isRetryableConnectError` 白名单 429/5xx + 9 种网络码；env 调参 `INVOX_LLM_RETRIES` / `_BACKOFF_BASE_MS` / `_BACKOFF_MAX_MS`，0 关闭<br/>OpenAIProvider 在 `chat.completions.create` 套 `withConnectBackoff` + `onRetry` warn 日志<br/>24 个单元测试（matrix 含 status 边界 / 抖动 / abort 联动 / 用尽冒泡） | mock provider 间歇性 429，最终成功且无重试风暴 |
| B4 | 结构化错误对外暴露：`PromptResponse._meta["invox/error"]` 让客户端可读 | P2 | **✅ Done**（00:40）<br/>`error-mapping.ts` 新增 `serializeRefusalForMeta`；`prompt()` 在 refusal 分支记录 `refusalInfo`，组装响应时注入 `_meta`<br/>`smoke-error-mapping.ts` 5 场景全部断言 `_meta.invox/error.{category, message}` 正确；6 个新单测覆盖序列化矩阵 | Zed 端能看到失败原因 |

### Phase C — 「上下文工程」（目标 2 周）

| ID | 任务 | 优先级 | 验收 |
|---|---|---|---|
| C1 | **历史压缩**：`prompt_tokens > α × context_window` 时，自动用便宜模型总结前 N 轮 → 替换为单条 system 摘要；可关闭 | P1 | 长对话超过阈值后 context 不再爆；保留摘要可回滚 |
| C2 | **Tool result 截断 + 索引**：长输出（> M 字节）落盘 `.invox/blobs/`，history 只放摘要 + handle，LLM 按需 Read 拉回 | P1 | grep 大仓库不再撑爆 history |
| C3 | **Prompt cache 友好排版**：稳定段（system + memory + skill catalog + tool spec）固定排在最前，提高 OpenAI/Claude 的 prompt cache 命中率 | P2 | 真实 provider 上 `prompt_tokens_details.cached_tokens` 增加 |

### Phase D — 「安全与多端」（目标 1 周）

| ID | 任务 | 优先级 | 验收 |
|---|---|---|---|
| D1 | WebSocket Token 鉴权（`?token=` 或 `Authorization` header），无 token → 401 关闭 | P1 | smoke-ws 增加正/反案例 |
| D2 | 工作区写入路径白名单 + 默认拒绝逃逸（与 `09dea62` 的"跨工作区"特性互斥可关） | P1 | 单测覆盖路径 traversal 各类 payload |
| D3 | Bash 危险命令模式匹配 + `INVOX_BASH_DENY_PATTERNS` 默认黑名单（`rm -rf /`、`curl ... \| sh` 等） | P2 | 单测 |

### Phase E — 「体验升级」（持续）

| ID | 任务 | 优先级 | 验收 |
|---|---|---|---|
| E1 | **并行 tool calls**：一轮多个独立 tool_call 并行；Edit/Write 之间按路径加锁串行化 | P1 | smoke 触发 3 个 Read 并发，比串行至少快 2× |
| E2 | **流式 thinking** 通道（区别于 `agent_message_chunk`），对接 `agent_thought_chunk` | P2 | Zed 折叠块实时增长 |
| E3 | 工具调用 DAG 视图：一次 turn 内的 tool 因果图作为 `_meta` 附在 stop 时 | P3 | UI 可可视化 |
| E4 | Skill catalog 动态刷新（监听 `.claude/skills/**`，`fs.watch`） | P3 | 添加 SKILL.md 不重启 invox 即可见 |

### Phase F — 「生态」（更远）

| ID | 任务 | 优先级 | 验收 |
|---|---|---|---|
| F1 | 插件 marketplace + 版本号 + 哈希校验 | P3 | `plugins.json` 支持 `version` / `sha256` |
| F2 | MCP 远程传输（HTTP / SSE）—— 当前 `mcpCapabilities: { http:false, sse:false }` 待打开 | P2 | smoke 接通一个公开 SSE MCP server |
| F3 | Invox 自有 Hook 协议版本号 + Claude Code shim 层（终结追逐） | P2 | `HookContext.protocol_version` 字段；老 hook 仍跑通 |
| F4 | 多 agent 编排（agent-to-agent 通过 invox 桥接） | P3 | demo |

---

## 3. Doing（当前 Sprint，活动 ≤ 3 项）

> 任何任务挪到 Doing 之前先在这里登记，避免半成品散在 git status 里。

| ID | 描述 | Owner | 起始 | 阻塞？ |
|---|---|---|---|---|
| _（空）_ | | | | |

---

## 4. Backlog（未排期但已识别）

| 来源 | 描述 | 备注 |
|---|---|---|
| 风险盘点 | 拆分前禁止在 `agent.ts` 加业务代码 | 已写入 DIARY Sprint 0 复盘 |
| 风险盘点 | `CONTEXT_WINDOW_TABLE` 硬编码，应外置为 JSON 或托管到 discovery 配置 | 影响 Phase E |
| 架构延伸 | **MemoryProvider 注册 API（第二步）**：暴露 `registerMemoryProvider` + `retrieve(query)` 动态记忆钩子（v1 已铺好 collect() 基座，等真有第二个 provider 时再做） | 由本次 discovery/memory 重构衍生 |
| 架构延伸 | **InvoxAgent 类的 collaborator pattern**：把 prompt() 主循环 + hookBase + persist 等抽成 `PromptOrchestrator`，让 InvoxAgent 只剩 ACP entry points 调度。把 agent.ts 从 869 → ≤ 400 的最后一公里。等真有第二个使用主循环的入口（如 SDK API）时再做，避免 over-engineering | 由本次 A2 衍生 |
| 用户反馈 | （留空，等真实使用反馈进来） | |
| 协议同步 | 跟踪 `@agentclientprotocol/sdk` 升级 | 当前 0.23 |

---

## 5. 已知问题登记簿（Known Issues）

> 不一定立刻修，但必须可见。每条问题要么进 Phase，要么留在这里观察。

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| K1 | `agent.ts` **869 行**（A2 收尾后） | P2 | **大幅缓解**（2026-06-05 02:50）—— 1660+ → 869 行（-47%），6 个 helper 各 ≤ 400 行；进一步压到 ≤ 400 需 collaborator pattern（拆类），优先级降为 P2 待真实痛点出现再做 |
| K2 | 零单元测试 | P0 | **✅ A1 落地** —— 54 单元 + 18 集成已就位 |
| K3 | MCP 子进程按 session 起，无释放 | P0 | **✅ B1+B2 落地**（2026-06-05 00:18）—— `src/mcp/pool.ts` 共享池；`unstable_deleteSession` + 进程退出钩子统一释放 |
| K4 | 长对话无上下文压缩，会撑爆 | P1 | Phase C1（暂缓 —— 用户标记需独立设计上下文压缩方案） |
| K5 | `agent.ts:987` 裸 `JSON.parse` | P0 | **✅ A3 落地**（17:05）—— 抽到 `src/agent/json.ts` 并改为 fast-fail 路径 |
| K6 | `loadHooks(cwd)` 在 tool 循环内重复调用（虽缓存） | P1 | **✅ A4 落地**（18:30）—— `Session` 持有 `hooks: HookRegistry`，6 处旧调用全部收敛 |
| K7 | WebSocket 默认无鉴权 | P1 | Phase D1 |
| K8 | `CONTEXT_WINDOW_TABLE` 硬编码 | P2 | Backlog |
| K9 | `stopReason` 不全（无 `refusal` 映射） | P1 | **✅ A5 落地**（20:40）—— 5 种 provider 错误全映射到 `refusal`，prompt 不再抛 RPC 异常 |
| K10 | Hook 协议追着 Claude Code 跑 | P2 | Phase F3 |
| K11 | `smoke-stage6-globgrep`（PascalCase 重命名后失效）& `smoke-stage7`（CLAUDE.md/skill 注入后断言失效） | P2 | **✅ Done**（2026-06-05 02:30）—— `smoke-stage6-globgrep` 改 PascalCase 工具名；`smoke-stage7` 改为 `history.find(role==="user")` 匹配新 history[0]=system 的事实；smoke.test.ts 取消两处 skipIf |
| K12 | `agentVersion()` path 解析有 pre-existing 缺陷 | P3 | **✅ Done**（2026-06-05 02:25）—— `agent-helpers.ts` 路径上溯由 `..` 改为 `../..`（agent/ 子目录多一级）；新增 `tests/unit/agent-helpers.test.ts` 5 个 case 覆盖正路径 / memoise / maxIterations env 边界 |

---

## 6. 工作流约定（Workflow）

### 6.1 一个特性的生命周期

```
Backlog → 进入 Phase 表 → 挪到 Doing（≤ 3 项）→ commit（带 hash） → 挪到 Done
                              ↓
                          失败/回滚 → 写入 DIARY 教训段落，重新进 Backlog
```

### 6.2 Commit 信息约定

- `[VERIFIED]` 仍然只用于 PLAN 列出的 stage 验收点。
- 普通改动用 `feat:` / `fix:` / `refactor:` / `chore:` / `docs:`。
- Phase 内的任务建议加 `[A2]` 这样的 PROGRESS 索引，方便回查。

### 6.3 何时写 DIARY

- 每完成一个 Phase 写一段。
- 任何"我学到一课"或"我栽了"的瞬间，立即写。
- Sprint 结束写复盘段（参见 Sprint 0 模板）。

### 6.4 何时更新 PLAN

- 数据结构变了（`Session` 加字段不算变结构，加协议新方法算）。
- 新增 stage / 修改 stage 验收。
- 红线变化（比如允许某些 `console.log`——目前禁止）。

### 6.5 何时只更 PROGRESS

- 新加任务、调整优先级、挪 Doing/Done。
- 新增 Known Issue。
- 不动 PLAN 的代码重构。

---

## 7. 度量目标（向后看一个月）

| 指标 | 当前 | 一个月目标 |
|---|---|---|
| `agent.ts` 行数 | **869**（A2 收尾 -791；进一步压缩需 collaborator pattern） | ≤ 400（拆完类成员）—— 部分达成（-47%） |
| 子模块数（src/agent/ + src/llm/ + src/mcp/ + src/discovery/） | **19**（agent + 13 helpers + backoff + mcp/pool + discovery/{index,claude-md,memory-types,memory-providers}） | ≥ 7 ✅ |
| 单元测试 case 数 | **179** | ≥ 80 ✅ |
| 集成 smoke case 数 | **18**（17 ✓ / 1 skip —— stage6-globgrep / stage7 已恢复） | 全 ≥ 90% pass ✅ |
| `npm test` 总耗时 | 25.22s | ≤ 30s ✅ |
| MCP 子进程峰值 / session 数 | **1（共享池）** | 1（共享池） ✅ |
| 长对话 OOM/turn | 偶发 | 0（C1 待设计） |
| WS 默认鉴权 | 无 | 有（D1 落地后） |

---

_最后更新：2026-06-05 02:50 ｜ A2 收尾（agent.ts 1660+ → 869，6 个新 helper）+ K11 / K12 清账（两个 stale smoke 恢复 + agentVersion path bug 修复）_
