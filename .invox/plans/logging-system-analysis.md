# InvoxAgent 日志系统分析报告

## Goal
全面调查 InvoxAgent 项目的日志架构设计、配置机制、使用模式及与追踪的关联。

---

## 一、架构总览

InvoxAgent 使用**完全自研的日志系统**（零第三方日志库依赖），核心实现在 `src/log.ts`，约 300 行。设计围绕一个核心约束：**stdout 专用于 JSON-RPC 帧**（stdio transport），所有日志一律走 **stderr (fd 2)**。

### 日志数据流

```
                         ┌─────────────────────────────┐
                         │  环境变量配置                  │
                         │  INVOX_LOG (级别)             │
                         │  INVOX_LOG_MODULE (模块过滤)   │
                         │  INVOX_LOG_FILE (全局文件)     │
                         │  INVOX_LOG_UTC (时间格式)      │
                         └──────────┬──────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────┐
│                    src/log.ts 核心层                      │
│                                                          │
│  createLogger(moduleName) → Logger                       │
│    ├── emit() → 格式化 → stderr.write(line)             │
│    │              └──→ fileStream.write(line) [可选]     │
│    └── isEnabled(level) → 跳过昂贵 payload 准备         │
│                                                          │
│  openSessionLogFile() → LogFile (同步写, 独立 fd)       │
│    └── writeSync → <cwd>/.invox/logs/<id>.log           │
│                                                          │
│  preview(s, max) → 单行截断 + 省略号                     │
│  formatTimestamp() → "MM-DD HH:mm:ss.SSS" 或 ISO UTC   │
└──────────┬──────────┬───────────────┬────────────────────┘
           │          │               │
           ▼          ▼               ▼
    ┌──────────┐ ┌──────────┐ ┌────────────────────┐
    │ stderr   │ │ INVOX_   │ │ .invox/logs/       │
    │ (全局)   │ │ LOG_FILE │ │   <session>.log    │
    │          │ │ (全局)   │ │   subagent-*.log   │
    └──────────┘ └──────────┘ └────────────────────┘
```

---

## 二、关键文件及职责

| 文件路径 | 职责 |
|---|---|
| `src/log.ts` | **日志核心**：Logger 接口、createLogger 工厂、emit 格式化、模块过滤、文件流、session 日志、preview 工具 |
| `tests/unit/log.test.ts` | 日志单元测试：覆盖模块过滤、级别、isEnabled |
| `src/agent/agent.ts` | Session 生命周期日志：session 创建/删除/turn start/end 写入 sessionLog |
| `src/agent/prompt-loop.ts` | 单轮 LLM↔tool 循环日志：tool batch start/end、tool start/end |
| `src/agent/sub-agent-runner.ts` | SubAgent 独立日志系统：openSubAgentLog、迭代日志、conn 代理静默 |
| `src/llm/openai.ts` | LLM 交互日志：request/response 统计、trace 级 payload dump |
| `src/cli.ts` | CLI 启动日志：provider 选择、transport、model 配置、信号处理 |
| `src/agent/templates.ts` | 模板加载日志：agent/model 解析 |
| `src/mcp/*.ts` | MCP 子系统日志：配置加载、连接失败 |
| `src/plugins/*.ts` | 插件子系统日志：加载、hooks 执行 |
| `src/tools/*.ts` | 工具子系统日志：bash shell 选择、rtk rewrite |
| `src/discovery/*.ts` | 发现子系统日志：plugins.json、settings 加载 |
| `src/persistence.ts` | 会话持久化日志：prune 淘汰 |

---

## 三、日志级别与格式

### 级别体系

| 级别 | 数值 | 用途 |
|---|---|---|
| `silent` | 0 | 完全静默 |
| `error` | 1 | 致命错误 |
| `warn` | 2 | 警告（如 MCP 连接失败、model 回退） |
| `info` | 3 | **默认级别**，关键事件流 |
| `debug` | 4 | 诊断信息（如 chunk gap、未知参数） |
| `trace` | 5 | 完整 LLM payload（**生产严禁开启**） |

### 格式化规则

**全局日志行格式**（`src/log.ts:169-172`）：
```
MM-DD HH:mm:ss.SSS [level] [moduleName] msg JSON(key-value...)
```

示例：
```
06-06 15:38:41.092 [info] [cli] starting {"name":"invox","version":"0.0.1",...}
06-06 15:38:41.143 [warn] [mcp] mcp server connect failed {"server":"codegraph","error":"..."}
```

**Session 日志格式**（`src/agent/agent.ts:256-262`）：
```
── session start @ MM-DD HH:mm:ss.SSS ───
  id:     <uuid>
  cwd:    <path>
  agent:  <agent-id>
  model:  <model-id>
  prompt: <prompt-id>
```

**SubAgent 日志格式**（`src/agent/sub-agent-runner.ts:379-387`）：
```
MM-DD HH:mm:ss.SSS ── subagent start ──────
  subagent_type: Worker
  model:         mimo-v2.5
  ...
  iter 1: start
  tool_call id=call_xxx kind=read title="Glob *"
  tool_call_update id=call_xxx status=completed title="Glob *"
  iter 1: continue
```

### 时间戳格式

- **默认**：本地时间 `"MM-DD HH:mm:ss.SSS"` — 便于人眼对照实际操作
- **UTC 模式**（`INVOX_LOG_UTC=1`）：`ISO.toISOString()` — 便于日志聚合

### preview 工具（`src/log.ts:298-302`）

将多行文本压成单行（`\n` → `\\n`），超过 max 字符截断加省略：
```
`…(+N chars)`
```
确保一行一个事件，便于 grep。

---

## 四、配置机制

### 环境变量控制（全部惰性读取，无缓存）

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `INVOX_LOG` | 全局日志级别 | `"info"` |
| `INVOX_LOG_MODULE` | 模块过滤（白名单/黑名单） | `"*"` (全部通过) |
| `INVOX_LOG_FILE` | 全局日志追加文件路径 | 未设置（仅 stderr） |
| `INVOX_LOG_UTC` | `"1"` = ISO UTC 时间戳 | 未设置（本地时间） |

### 模块过滤语法（`src/log.ts:53-87`）

- `*` → 全部通过
- `""` / `[]` → 全部静默
- `aa,bb` → 仅 aa、bb 通过（白名单）
- `*,-aa,-bb` → 除了 aa、bb 都通过（黑名单排除）

### 动态调整

**惰性读取策略**（`src/log.ts:44-47, 89-92`）：每次调用 `currentLevel()` 和 `currentModuleFilter()` 都从 `process.env` 重新读取，**不缓存**。这意味着运行时修改环境变量即时生效，无需重启。

### 可用模块名称（通过 grep `createLogger()` 得到）

| 模块名 | 所在文件 |
|---|---|
| `core` | `src/log.ts` (默认导出) |
| `cli` | `src/cli.ts` |
| `agent` | `src/agent/agent.ts` |
| `prompt-loop` | `src/agent/prompt-loop.ts` |
| `sub-agent` | `src/agent/sub-agent-runner.ts` |
| `templates` | `src/agent/templates.ts` |
| `mcp-lifecycle` | `src/agent/mcp-lifecycle.ts` |
| `llm` | `src/llm/openai.ts` |
| `tools` | `src/tools/{bash,glob,grep,edit-file,read-file,write-file,router,make-plan,skill,permissions}.ts` |
| `transport` | `src/transports/{stdio,websocket}.ts` |
| `mcp` | `src/mcp/{client,config,pool}.ts` |
| `plugins` | `src/plugins/{loader,hooks}.ts` |
| `discovery` | `src/discovery/{index,memory-providers}.ts` |
| `persistence` | `src/persistence.ts` |

---

## 五、三级日志存储架构

### 第一级：stderr（全局实时）

所有模块日志都输出到 stderr。在 Zed 集成中 stderr 不易看见，但可通过 `INVOX_LOG_FILE` 落盘。

### 第二级：全局文件（`INVOX_LOG_FILE`）

由 `src/log.ts:99-121` 的 `getFileStream()` 管理：
- 以 append 模式打开
- 每次 invox 会话启动写入分隔标记（`--- invox started @ ... pid=... ---`）
- 懒初始化 + `fileStreamTried` 哈希保护
- 错误通过 stderr 输出，避免递归

### 第三级：Session/SubAgent 独立日志（`.invox/logs/`）

#### Session 日志
- **创建**：`src/agent/agent.ts:254` — `openSessionLogFile(cwd, sessionId, "session")`
- **路径**：`<cwd>/.invox/logs/<sessionId>.log`
- **内容**：session 生命周期（start/end）、每轮 turn（start/user preview/end usage）、工具调用摘要
- **关闭**：`src/agent/agent.ts:471` — session 删除时

#### SubAgent 日志
- **创建**：`src/agent/sub-agent-runner.ts:131-168` — `openSubAgentLog(cwd, parentId, runId)`
- **路径**：`<cwd>/.invox/logs/subagent-<id8>-<runId8>-<ISO时间戳>.log`
- **文件名 Windows 兼容**：ISO 时间戳中冒号/点替换为短横（`:156 → -156`）
- **内容**：subagent 完整执行轨迹（prompt、每 iter 的 tool_call/tool_call_update/assistant_text、最终状态）
- **噪音过滤**（`src/agent/sub-agent-runner.ts:693-709`）：1500+ 条 notif → ~80 条真信号
  - 丢弃：`agent_message_chunk`、`agent_thought_chunk`、`usage_update`、`plan`、`available_commands_update`、`tool_call_update(in_progress)`
  - 保留：`tool_call`(启动)、`tool_call_update`(终态)、未识别 kind

**设计亮点**：同步写（openSync/writeSync/closeSync）换"返回时文件一定可见"的强保证，适合单测直接 readFileSync 验证。

---

## 六、日志与工具调用 / 请求追踪的关联

### 请求追踪机制

项目没有使用 OpenTelemetry 或任何外部 tracing 库，而是通过以下方式实现请求关联：

1. **callId 追踪**：LLM 每次请求分配递增 callId（`c1`, `c2`, ...），贯穿 request/response 配对
   - `src/llm/openai.ts:64` → `log.info("llm: request", { callId, ... })`
   - `src/llm/openai.ts:227` → `log.info("llm: response", { callId, elapsedMs, ttfbMs, ... })`

2. **toolCallId 追踪**：每个工具调用有唯一 ID，贯穿 start/end 配对
   - `src/agent/prompt-loop.ts:370` → `log.info("tool start", { name, toolCallId, argsPreview })`
   - `src/agent/prompt-loop.ts:471` → `log.info("tool end", { name, toolCallId, ok, elapsedMs })`

3. **sessionId 追踪**：session 级别事件携带 sessionId
   - `src/agent/agent.ts:650` → `log.info("prompt received", { sessionId, userText, ... })`

4. **isEnabled 性能保护**（`src/llm/openai.ts:72, 241`）：trace 级 payload dump 先检查 `isEnabled("trace")`，避免在非 trace 级别时仍构建昂贵的消息序列化

### SubAgent 连接代理（`wrapConnForSubAgent`）

`src/agent/sub-agent-runner.ts:729-769` 中通过 `Proxy` 包装父 conn：
- `sessionUpdate` 方法被完全静默（不向父 UI 转发）
- 关键事件镜像到 subagent 自己的日志文件
- 非 `sessionUpdate` 方法（如 `readTextFile`、`writeTextFile`）原样转发

这实现了"subagent 工具卡折叠"的视觉效果：用户只看到一张 SubAgent 卡，子工具调用详情全部写入独立日志文件。

---

## 七、日志轮转与清理

### 当前状态：**无自动轮转/清理机制**

- `INVOX_LOG_FILE`（全局日志）：append-only，**无 maxSize、无轮转、无 prune**
- `.invox/logs/`（session/subagent 日志）：每个 session/subagent 一个文件，**无自动清理**
- `persistence.ts:182` 的 `prune()` 只清理过期的 **session JSON 文件**（`.invox/sessions/*.json`），不涉及日志文件

### 现有清理

`src/persistence.ts:12` — session JSON 按 `INVOX_SESSION_TTL_DAYS`（默认 30 天）淘汰，但日志文件未纳入。

---

## 八、设计亮点

1. **零依赖自研**：不依赖 winston/pino/bunyan 等，完全控制格式和输出路径，适合嵌入式 CLI 场景
2. **stdout 隔离**：所有日志走 stderr，stdout 完整留给 JSON-RPC 帧 — 这是 stdio transport 正确运行的铁律
3. **模块过滤语法**：支持白名单 + 黑名单组合（`*,-agent,llm`），粒度控制极细
4. **惰性读取 env**：每次调用实时读 `process.env`，运行时调参无需重启
5. **isEnabled 守卫**：昂贵的 payload 准备（如序列化完整 LLM messages）可被短路
6. **preview() 单行化**：多行内容压成单行 + 截断 + 长度提示，grep 友好
7. **SubAgent 日志降噪**：1500+ notif → ~80 条信号，精心设计 `shouldLogNotif` 过滤器
8. **noop 兜底模式**：mkdir/fd 失败时返回全空操作的 LogFile，日志故障不拖崩主流程
9. **双轨日志**：全局日志（stderr + optional file）用于运维排查；session/subagent 日志用于业务追踪

---

## 九、潜在问题与风险

1. **无日志轮转**：`INVOX_LOG_FILE` 和 `.invox/logs/` 无 maxSize/prune，长时间运行会持续增长。当前子代理每次执行都创建新文件，累积速度更快。

2. **非结构化 session/subagent 日志**：全局日志是 `[level] [module]` 结构化格式，但 session/subagent 日志是纯文本拼接（`formatTimestamp + preview`），无法被日志聚合工具（如 ELK、Grafana）直接解析。

3. **trace 级安全风险**：`src/log.ts:8-9` 注释警告"生产严禁开启 trace"（prompt/工具输出可能含密钥），但没有强制的运行时保护 — 如果某用户在生产环境设置了 `INVOX_LOG=trace`，敏感数据会落入 `INVOX_LOG_FILE`。

4. **session 日志无清理联动**：session JSON 文件被 prune 时，对应的 `.invox/logs/<sessionId>.log` 和 subagent 日志不会被删除。

5. **subagent 日志 `preview()` 重复定义**：`src/agent/sub-agent-runner.ts:629` 本地重新实现了一个 `preview()` 函数，与 `src/log.ts:298` 的实现逻辑完全相同但未复用（sub-agent-runner 为了独立性自行实现了副本）。

6. **`INVOX_LOG_FILE` 文件流未 flush**：使用 `createWriteStream` 以 append 模式写入，但未调用 `fsync` 或 `stream.end()`，进程崩溃时最后几行可能丢失。

---

## 十、Open Questions

1. 是否需要为 `.invox/logs/` 添加自动清理机制（如按 TTL 或文件数上限）？
2. session/subagent 日志是否应升级为结构化 JSON 格式以便聚合分析？
3. 是否需要对 `INVOX_LOG=trace` 在生产模式下增加警告或拦截？
4. subagent 日志中的 `preview()` 副本是否应统一引用 `src/log.ts` 的导出？
