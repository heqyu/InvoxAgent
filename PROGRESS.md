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

## 0. 当前快照（2026-06-05 16:18）

| 维度 | 状态 |
|---|---|
| 版本 | `0.0.1` |
| 代码量 | ~9300 行 TS / 56 文件（Phase G：新增 src/agent/templates.ts） |
| 已完成 stage | 0–8 + Phase A–B + **Phase G**（全部 `[VERIFIED]`） |
| 传输 | stdio + WebSocket |
| 工具 | Read / Write / Edit / Bash / Glob / Grep / Skill + MCP 桥接（**支持按 agent 模板过滤白名单**） |
| 协议外特性 | 会话持久化 / Zed thread 同步 / 模型菜单 / token 计费 / system prompt 模板 / **自定义 Agent 模板（Plan/Ask/Worker/CodeReviewer + 用户自定义）** / thinking 模式 / 三层 discovery / 统一记忆系统 / 插件 + Hook / MCP 共享池 / 连接重试 / 结构化错误 |
| 测试 | **vitest 4.1.8**：240 个 case（207 单元 + 33 集成）— 240 ✓ / 1 skip / 0 fail，25.34s |
| 已知风险 | `agent.ts` ~960 行（Phase G 净增 ~90 行），仍 > 400；进一步拆需 collaborator pattern |

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

### Phase G — 「自定义 Agent 模板」（已完成，2026-06-05 16:18）

> 用户原话："给 invox 实现自定义 Agent 模板的功能。具体是可以在 `.invox/agents/` 目录下配置多套 agent。比如 Plan、Ask、Worker、Code With Me、Solo、CodeReviewer 等。每个 agent 可以单独配置提示词，可以用的工具集合，是否允许加载 mcp 工具。然后再 zed 下方可以选择使用哪个 agent。"

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| G1 | `src/agent/templates.ts` —— `AgentTemplate` 类型 + 三层 loader（项目/用户/内置）+ `filterToolSpecsByAgent` + `agentAllowsMcp` | P0 | **✅ Done**（16:00）<br/>新建 templates.ts (~280 行) + tests/unit/agent-templates.test.ts (28 case)<br/>4 套内置：Worker（全开）/ Plan（只读勘察）/ Ask（无工具）/ CodeReviewer（只读+Bash） | typecheck 绿；28 个新单测全过 |
| G2 | 接线：`AgentConfigOptions` 加 `agents` 字段；`buildConfigOptions` 暴露 "agent" 下拉、隐藏 "system_prompt"；agent.ts 处理 `configId="agent"`；prompt-loop 按 agent 过滤 toolSpecs / MCP | P0 | **✅ Done**（16:15）<br/>改 4 文件（session-types / config-options / agent / prompt-loop），新增 `IterationDeps.activeAgent`；私有 `effectiveSystemPromptBody` / `activeAgentFor` helper | typecheck 绿；现有 211 单测全过 |
| G3 | CLI 接入 + `INVOX_AGENTS` / `INVOX_AGENTS_DIR` / `INVOX_DEFAULT_AGENT` env + `examples/smoke-agents.ts` + README + PROGRESS | P0 | **✅ Done**（16:18）<br/>cli.ts 加 `pickConfigOptions` 升级版；`smoke-agents.ts` 端到端验证（4 场景：下拉 / 切换 / 持久化 / 重启恢复）；老 `smoke-config-options.ts` 加 `INVOX_AGENTS=disabled` 保留旧路径回归 | smoke-agents PASS；`npm test` 240 ✓ / 1 skip |

### Phase H — 「Agent 模型配置 + INVOX_MODEL_PRO/LITE」（已完成，2026-06-05 17:35）

> 用户原话："给 agent 增加模型的配置。同时给 invox 定义2个环境变量， MODEL_PRO  MODEL_LITE，意思是当任务需要高度推理规划时使用专业模型，当只负责干活时使用 LITE。agent 的模型配置要么可以配具体的模型 id，要么就是配环境变量。"

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| H1 | `AgentTemplate.model` 字段 + `resolveAgentModel` 纯函数（占位符 `$MODEL_PRO/$MODEL_LITE/$ANY_VAR` 解析）+ 22 单测 | P0 | **✅ Done**（17:20）<br/>`readEnvModelPro/Lite` helper：先 `INVOX_MODEL_PRO/LITE` 标准名，回退 `MODEL_PRO/LITE` 别名；空字符串视为未设；解析失败 warn + 回退，永不抛错 | 51 个 agent-templates 单测 PASS |
| H2 | CLI 接入：`pickModels()` 把 PRO/LITE 解析后的实际值并入 `availableModels`；help 文档更新 | P0 | **✅ Done**（17:25）<br/>解析失败时静默不并入；解析成功且不重复时 push 到 menu 末尾 | typecheck 绿 |
| H3 | `agent.ts.applyAgentModel` —— newSession 默认 agent 应用 model；setSessionConfigOption(agent) 切换同步 selectedModel + configValues.model；解析后的 id 不在 `availableModelIds` 里时动态加入 | P0 | **✅ Done**（17:30）<br/>永不抛错（fallback 等于当前时 no-op）；prompt-loop 零改动（继续读 session.selectedModel）；BUILTIN/SEED 默认 model：Worker→`$MODEL_LITE`、Plan/CodeReviewer→`$MODEL_PRO`、Ask 不设 | smoke-agents 扩展 8 步全过 |
| H4 | smoke-agents 扩展 + README/PROGRESS | P0 | **✅ Done**（17:35）<br/>4 个新断言：默认 Worker→test-lite-model、PRO/LITE 自动入 menu、切 Plan→model 同步切到 test-pro-model、磁盘 selectedModel=test-pro-model | `npm test` 263 ✓ / 1 skip |

### Phase I — 「SubAgent 工具：让 LLM 委派子任务给 agent 模板」（已完成，2026-06-05 22:20）

> 用户原话："给 invox 实现 SubAgent tool，subagent 可以加载 agent 模板来创建新的子agent。工具定义和参数可以参考 Claude Code 的 Agent tool。"

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| I1 | `src/agent/sub-agent-runner.ts` —— `runSubAgent(deps, opts, signal)`：解析 model 占位符 → 构造独立 sub-Session（共享 cwd / mcpClient / hooks / abort，但独立 history / toolState / turnUsage）→ 跑 prompt-loop（注入 `inSubAgent=true`）→ 合并 turnUsage 回父 → 返回最终 assistant 文本 | P0 | **✅ Done**（22:18）<br/>Proxy 包装 conn：`agent_message_chunk`→`agent_thought_chunk`，`usage_update` 吞掉；abort 链路双向（父 abort / 外部 signal 任一触发即停）；max iter `INVOX_SUBAGENT_MAX_ITERATIONS` env 可调，默认 min(父上限, 25) | typecheck 绿；15 个新单测 PASS |
| I2 | `src/tools/sub-agent.ts` —— `subAgentTool` 工具：spec 含 description / prompt / subagent_type / model（前 3 个 required）；execute 校验 + 调 `ctx.subAgentRunner` + 拼装带 provenance header 的结果 | P0 | **✅ Done**（22:18）<br/>tier=`execute`（writes/always 策略下需许可一次）；递归屏障检查 `subAgentRunner` 是否注入；title 用 description 优先 | tool 注册到 TOOLS 数组；spec.required=["description","prompt","subagent_type"] |
| I3 | 接线：`tools/types.ts` 加 `SubAgentRunner` 类型 + `ToolExecContext.subAgentRunner?`；`prompt-loop.ts` 加 `IterationDeps.{agentRegistry, inSubAgent}`，`inSubAgent=true` 时剔除 SubAgent 规范，并按需把 `makeSubAgentRunner(session, deps)` 注入 ctx；`agent.ts` 把 `this.agentById` 作为 `agentRegistry` 传入 | P0 | **✅ Done**（22:18）<br/>双层递归屏障：(a) toolSpecs 中剔除 SubAgent；(b) ctx.subAgentRunner=undefined 时工具直接 fail-fast | typecheck 绿；既有 280 测试 + 15 新测 全过 |
| I4 | 单元测试 `tests/unit/sub-agent-runner.test.ts` —— 9 个 runner 用例 + 6 个工具用例（注册表为空 / 未知 type / 空 prompt / 父 abort / 外部 signal abort / model 解析优先级 / history 隔离 / 工具递归屏障 / provenance header 格式 等） | P0 | **✅ Done**（22:20）<br/>15 case 全过；`npm test` 295 ✓ / 1 skip / 0 fail | 295 测试全绿 |

### Phase I.5 — 「SubAgent v2：UI 收缩 / 独立日志 / 并行执行」（已完成，2026-06-06 01:40）

> 用户原话："subagent 的工具调用收缩在 subagent 内，而不是展示在主 agent。同时 subagent 应该有自己的日志文件，而不是和主 agent 混在一起。另外 subagent 应该是可以支持多个并行的，主 agent 应该等待执行完成。另外父 agent 的 token 消耗主要是用于统计距离 max 还有多大的空间，所以 subagent 占用的不是父 agent 的上下文，无需累加进去。"

| ID | 任务 | 优先级 | 状态 | 验收 |
|---|---|---|---|---|
| I5 | 修正 token 语义：subagent 的 turnUsage **不**累加进 parent.turnUsage（删 mergeTurnUsage 函数）。父 turnUsage 仅估父 context 余量；subagent 跑在独立 history，不占父 context | P0 | **✅ Done**（01:14）<br/>测试用例反向断言：subagent 跑完后 parent.turnUsage 维持原值不变 | typecheck 绿 |
| I6 | 包装 conn 全量静默：subagent 内部所有 `sessionUpdate`（tool_call / tool_call_update / agent_message_chunk / usage_update / ...）都不向父 UI 转发；改为按时间序写到 subagent 自己的日志文件。父对话面板上只看到一张 SubAgent 工具卡 | P0 | **✅ Done**（01:30）<br/>非 sessionUpdate 方法（readTextFile / writeTextFile / requestPermission）原样转发 | 单测断言 `notifs.length === 0` |
| I7 | 独立日志文件：每个 subagent run 写到 `<cwd>/.invox/logs/subagent-<pid8>-<runid8>-<ts>.log`。同步写（openSync/writeSync/closeSync），保证 runSubAgent 返回时文件可见。失败仅 warn，主流程不挂。日志含 start / iter N / done 三段，外加每条 sessionUpdate 摘要 | P0 | **✅ Done**（01:38）<br/>SubAgentRunResult 加 `logPath?` 字段；SubAgent 工具结果带 `[log: <path>]` provenance header | 单测：日志文件存在、含 start/iter/done 段；并发 subagent 各自独立文件 |
| I8 | 多 subagent 并行：在 prompt-loop.ts 加 `PARALLEL_SAFE_OVERRIDE_TOOL_NAMES = {"SubAgent"}`，让 SubAgent 即便是 execute tier 也可放进同一并行批次。父 prompt-loop 用 Promise.all 等全部完成才进下一轮 | P0 | **✅ Done**（01:30）<br/>每个 subagent 独立 history/toolState/abort/turnUsage，无共享可变状态 | prompt-loop-parallel.test：[SubAgent×2, Read] 并行 / Edit 屏障 / [SubAgent] 并行 |
| I9 | 实时进度回流：`SubAgentRunRequest` 加 `parentToolCallId`；runner 内 `makeProgressEmitter` 用未经 wrap 的原 conn 发 `tool_call_update` 更新父 SubAgent 工具卡 content；wrappedConn 拦到 inner `tool_call` 时旁路给 emitter；末态 `acpContent` 把 progressLines（"▸ Glob ..." / "▸ Read ..." 等）作为审计轨迹拼到工具卡内（`resultText` 不含，避免污染父 LLM context） | P0 | **✅ Done**（01:52）<br/>UI 卡片首行始终是 `Log: <path>`，让用户能直接从卡片看到独立日志位置（解决"日志文件放哪里"的发现性问题）；progressLines 出现在 `SubAgentRunResult` 与最终 acpContent，但**不**进 resultText | sub-agent-runner.test：进度 lines 含 "Log:" + "▸ subagent started" + "▸ Read"；不传 parentToolCallId 时保持纯静默 |







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

_最后更新：2026-06-05 17:35 ｜ Phase H 落地（Agent 模型配置：`AgentTemplate.model` 支持 `$MODEL_PRO/LITE/任意 ENV` 占位符；新增 `INVOX_MODEL_PRO/LITE` 一等环境变量；BUILTIN：Worker→LITE，Plan/CodeReviewer→PRO；切 agent 自动同步 model 下拉；263 测试全绿）_
