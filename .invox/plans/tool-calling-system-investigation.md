# InvoxAgent 工具调用（Tool Calling）系统深度调查报告

## 1. Goal

全面梳理 InvoxAgent 项目中工具调用子系统的设计架构，覆盖定义、注册、路由、执行、错误处理、权限控制及模块交互。

---

## 2. 系统概览

InvoxAgent 是一个 ACP（Agent Client Protocol）兼容的 Agent 服务器，将任意 OpenAI 兼容 LLM 端点桥接到代码编辑器（Zed）。工具调用系统是其核心能力层——LLM 通过 `tool_calls` 请求执行外部操作，系统将请求翻译为本地文件/进程/MCP 操作。

**核心设计哲学**：工具 = 可插拔的 `Tool` 接口实例；路由 = 按 name 查表；权限 = 策略门控；状态 = 会话级共享。

---

## 3. 关键文件索引与职责

### 3.1 工具定义层

| 文件 | 职责 | 亮点 |
|---|---|---|
| `src/tools/types.ts` | 工具子系统共享类型与契约：`Tool` 接口、`ToolExecContext`、`ToolExecResult`、`SessionToolState` | **SubAgent 调用签名放在此处而非 agent/ 目录**，避免 tools → agent 的反向依赖 |
| `src/tools/registry.ts` | 唯一列出所有内置工具的位置，`TOOLS` 数组 + `TOOL_BY_NAME` Map + `getTool()` | 唯一注册点，新增工具只需加一行 |
| `src/tools/router.ts` | 调度器：解析参数 → 权限闸门 → 调用 `tool.execute()` | 薄层，57 行，职责极纯 |
| `src/tools/permissions.ts` | 权限闸门：`needsPermission()` + `requestPermission()` (ACP `session/request_permission`) | 三级策略：never / writes / always |
| `src/tools/cache.ts` | 每会话的文件内容缓存 `FileCache` | 命中率统计、有意不检测会话外修改 |
| `src/tools/fs-utils.ts` | 工作区外文件 I/O 的共享 helper：路径规范化、工作区边界判定、缓存读取 | Windows Unix 路径兼容 |

### 3.2 内置工具实现

| 文件 | 工具名 | tier | 核心功能 |
|---|---|---|---|
| `src/tools/read-file.ts` | Read | read | 行号化分页读取，带缓存，标记 readPaths |
| `src/tools/write-file.ts` | Write | write | 创建新文件，自动 mkdir -p |
| `src/tools/edit-file.ts` | Edit | write | 精确字符串替换 + 唯一性强制，auto-read，diff 回报 |
| `src/tools/make-plan.ts` | MakePlan | write | 保存 Markdown 计划到 `.invox/plans/` |
| `src/tools/glob.ts` | Glob | read | 文件名模式匹配 |
| `src/tools/grep.ts` | Grep | read | 正则内容搜索 |
| `src/tools/bash.ts` | Bash | execute | Shell 命令执行，双路径（ACP terminal / 本地 spawn），rtk rewrite 集成 |
| `src/tools/skill.ts` | Skill | read | 可复用 prompt 模板的加载与插值 |
| `src/tools/sub-agent.ts` | SubAgent | execute (uiKind="other") | 子任务委派，动态描述，递归屏障 |

### 3.3 调度与生命周期

| 文件 | 职责 |
|---|---|
| `src/agent/prompt-loop.ts` | **单轮 LLM ↔ tool 往返的核心循环**：stream LLM → 收集 tool_calls → 并行/串行批次执行 → 写 history |
| `src/agent/agent.ts` | ACP `Agent` 接口实现，`prompt()` 主循环（最多 MAX_ITERATIONS=50 次迭代），session 管理 |
| `src/agent/sub-agent-runner.ts` | SubAgent 的嵌套 prompt loop，独立 history/toolState/abort，conn 全量静默 |
| `src/agent/json.ts` | 容错 JSON 解析：`parseToolArguments()` 区分空/合法/畸形 |
| `src/agent/tool-presentation.ts` | 纯渲染函数：标题、预览、locations |
| `src/agent/error-mapping.ts` | LLM provider 错误 → ACP stopReason 映射 |
| `src/agent/templates.ts` | Agent 模板加载、工具白名单过滤（白名单/黑名单/减法模式） |

### 3.4 外部集成

| 文件 | 职责 |
|---|---|
| `src/mcp/tool.ts` | MCP 工具工厂：把 MCP 工具包装成 invox `Tool` 实例 |
| `src/mcp/client.ts` | MCP 服务器连接管理 |
| `src/mcp/pool.ts` | 同 cwd 共享 MCP 子进程池 |
| `src/plugins/hooks.ts` | 插件 hook 系统：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop |
| `src/llm/backoff.ts` | LLM 连接阶段的指数退避重试 |
| `src/log.ts` | 日志系统，模块级 `createLogger("name")` |

---

## 4. 工具定义与注册机制

### 4.1 Tool 接口契约 (`src/tools/types.ts:132-160`)

```typescript
interface Tool {
  readonly name: string;          // PascalCase 唯一标识
  readonly tier: RiskTier;        // "read" | "write" | "execute"
  readonly uiKind?: "read" | "edit" | "execute" | "other";  // UI 渲染等级（可覆盖）
  readonly spec: ToolSpec;        // OpenAI function calling 规范
  execute(args, ctx): Promise<ToolExecResult>;  // 真正执行
}
```

**设计亮点**：
- **tier（安全维度）与 uiKind（渲染维度）解耦**：SubAgent 的 `tier="execute"`（可触发任意子工具）但 `uiKind="other"`（通用可展开卡片，而非 terminal 风格）。`src/tools/types.ts:141-152` 详细注释了原因。
- **`SessionToolState` 是跨工具调用的共享状态**：包含 `readPaths`（已读路径集合，Edit 的前置闸门）和 `FileCache`（文件内容缓存）。挂在 session 上，按引用注入每次工具调用。

### 4.2 注册表 (`src/tools/registry.ts`)

```typescript
export const TOOLS: readonly Tool[] = [
  readFileTool, writeFileTool, editFileTool, makePlanTool,
  globTool, grepTool, bashTool, skillTool, subAgentTool,
];
const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));
export function getTool(name: string): Tool | undefined { return TOOL_BY_NAME.get(name); }
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);
```

- **唯一注册点**：新增工具只需实现 `Tool` 并加入 `TOOLS` 数组
- `TOOL_SPECS` 直接喂给 LLM 作为 `tools` 参数

---

## 5. 工具调用的完整生命周期

### 5.1 核心流程（Mermaid）

```
用户输入 → agent.prompt()
  │
  ├─ buildUserContent() → 追加到 session.history
  │
  └─ runOneIteration() × N (最多 MAX_ITERATIONS=50)
       │
       ├─ 1. 构建 toolSpecs
       │     ├─ TOOL_SPECS（内置工具）
       │     ├─ filterToolSpecsByAgent(agent.tools) → 白名单/黑名单过滤
       │     ├─ inSubAgent 时剔除 SubAgent 工具（递归屏障）
       │     ├─ agentAllowsMcp(agent) ? session.mcpClient.getToolSpecs() : []
       │     └─ buildDynamicSubAgentSpec() → 替换 {AGENT_LIST} 占位符
       │
       ├─ 2. provider.stream({ messages, tools, model, ... })
       │     └─ yields: text | tool_call | usage | finish
       │
       ├─ 3. finishReason === "tool_calls" ?
       │     ├─ No → end_turn (push assistant text to history)
       │     └─ Yes → push assistant message + tool_calls to history
       │            └─ executeToolCallBatches(toolCalls, session, deps)
       │
       └─ 4. 批次执行 planToolCallBatches()
             │
             ├─ parallel 批次（只读工具：Read/Glob/Grep/Skill/SubAgent）
             │   └─ Promise.all(batch.map(runOneToolCall))
             │
             └─ serial 批次（写入/执行工具：Bash/Edit/Write/MakePlan/MCP/未知）
                 └─ await runOneToolCall(call)
                      │
                      ├─ 4a. emit tool_call (in_progress)
                      ├─ 4b. parseToolArguments(call.arguments)
                      │       └─ 畸形 JSON → emit failed + error tool message → return
                      ├─ 4c. PreToolUse hook → 拦截检查
                      ├─ 4d. 构建 ToolExecContext（含 subAgentRunner 闭包）
                      ├─ 4e. executeTool(name, rawArgs, ctx)
                      │       ├─ getTool(name) → 未找到 → errorResult
                      │       ├─ parseToolArguments(rawArgs) → 畸形 → errorResult
                      │       ├─ needsPermission(tool.tier, ctx.policy) ?
                      │       │   └─ requestPermission() → ACP session/request_permission
                      │       └─ tool.execute(args, ctx) → ToolExecResult
                      ├─ 4f. PostToolUse / PostToolUseFailure hook
                      ├─ 4g. emit tool_call_update (completed/failed)
                      └─ 4h. return LLMMessage { role: "tool", content: resultText }
```

### 5.2 并行调度策略 (`src/agent/prompt-loop.ts:110-165`)

```typescript
const NON_PARALLEL_TOOL_NAMES = new Set(["Bash", "Edit"]);
const PARALLEL_SAFE_OVERRIDE_TOOL_NAMES = new Set(["SubAgent"]);

function isParallelSafeToolCall(call): boolean {
  // Bash/Edit → 串行
  // SubAgent → 强制并行（每个 subagent 独立 history/toolState）
  // 其它 tier=read → 并行；tier=write/execute → 串行
}
```

**设计亮点**：
- `planToolCallBatches()` 按**明显顺序依赖**切分：连续的并行安全调用合并为一个 parallel 批次，遇到串行屏障就 flush
- SubAgent 被强制并行：每个 subagent 隔离，真正"并行不安全"的 Edit/Bash 在 subagent 内部各自串行化

---

## 6. 请求/响应数据结构

### 6.1 工具调用输入

LLM 返回 `tool_calls`，每个 `ParsedToolCall`：
```typescript
// src/llm/types.ts:34-38
interface ParsedToolCall {
  id: string;           // ACP tool_call_id
  name: string;         // 工具名（如 "Read"）
  arguments: string;    // JSON object 字符串
}
```

### 6.2 参数解析 (`src/agent/json.ts:51-78`)

`parseToolArguments(rawArgs)` 返回 discriminated union：
- `{ ok: true, value: Record<string, unknown> }` — 合法（空字符串视为 `{}`）
- `{ ok: false, error: string }` — 畸形 JSON，error 文案给 LLM 看以自我纠错

### 6.3 执行上下文 (`src/tools/types.ts:90-106`)

```typescript
interface ToolExecContext {
  conn: AgentSideConnection;     // ACP 连接（读写文件、权限请求）
  sessionId: string;
  cwd: string;
  caps: ClientCapabilities;      // 客户端能力（terminal: true? fs.readTextFile?）
  signal: AbortSignal;            // 取消信号
  policy: PermissionPolicy;       // 权限策略
  toolCallId: string;
  state: SessionToolState;        // readPaths + FileCache（跨工具共享）
  subAgentRunner?: SubAgentRunner; // 仅父循环存在（递归屏障）
}
```

### 6.4 执行结果 (`src/tools/types.ts:109-127`)

```typescript
interface ToolExecResult {
  resultText: string;                    // 喂回 LLM 的 tool message
  acpContent: ToolCallContent[];         // ACP tool_call_update 的富内容
  kind: "read" | "edit" | "execute" | "other";  // UI 渲染等级
  title: string;                         // 客户端 UI 标题
  locations?: ToolCallLocation[];        // "Go to File" 跳转链接
  ok: boolean;                           // 驱动 status: completed/failed
  denied?: boolean;                      // 用户拒绝
}
```

### 6.5 ACP 通知流

工具执行期间发出的 ACP `session/update` 通知序列：
```
tool_call          (in_progress)   → 开始执行，UI 显示加载状态
  ↓ 工具执行中
tool_call_update   (in_progress)   → Bash terminal 的 terminalId 挂载
tool_call_update   (completed/failed) → 最终结果（content + locations）
```

---

## 7. 错误处理机制

### 7.1 三层防线

1. **参数解析层** (`json.ts`)：畸形 JSON → 返回 errorResult，LLM 看到错误信息自行纠错
2. **工具执行层** (`router.ts` + 各工具)：工具内部 catch → `errorResult()` 统一构造
3. **顶层兜底** (`agent.ts:762-778`)：`prompt()` 的 try-catch 把所有未预期异常映射为 refusal

### 7.2 LLM Provider 错误映射 (`error-mapping.ts`)

```
classifyProviderError(err) →
  AbortError          → { kind: "abort" }       → stopReason: "cancelled"
  HTTP 429            → { kind: "refusal", info: { category: "rate_limit" } }
  HTTP 401/403        → { kind: "refusal", info: { category: "auth" } }
  HTTP 5xx            → { kind: "refusal", info: { category: "server" } }
  ECONNRESET/ETIMEDOUT → { kind: "refusal", info: { category: "network" } }
  其它                → { kind: "refusal", info: { category: "unknown" } }
```

**设计亮点**：prompt() **绝不向 ACP RPC 抛异常**——所有错误路径都产出合法的 `PromptResponse`，附带 `_meta["invox/error"]` 机读元数据。

### 7.3 LLM 连接重试 (`src/llm/backoff.ts`)

仅在 **stream 还没开始** 之前重试（connect 阶段），因为：
- mid-stream 重放会破坏 ACP UI 增量渲染
- tool_call 部分流出后再重放会触发重复执行

```
withConnectBackoff(task, cfg)
  → 429 / 5xx / ECONNRESET / ETIMEDOUT / ...
  → 指数退避：min(base * 2^attempt, max) ± jitter
  → 默认：3 次重试，500ms 基数，8000ms 上限，0.3 抖动
  → 可通过 INVOX_LLM_RETRIES / INVOX_LLM_BACKOFF_BASE_MS / INVOX_LLM_BACKOFF_MAX_MS 调参
```

### 7.4 无重试的场景

- **工具调用本身不重试**：LLM 自带"自我纠错"能力——工具返回 errorResult → 错误信息作为 tool message 回灌 LLM → LLM 看到错误后自主调整策略
- **Stop hook 阻塞后重跑**：`agent.ts:720-748` 的 stop hook 机制让 agent loop 在自然停止时被 hook 注入新指令，相当于一种"用户级重试"

---

## 8. 权限/安全控制

### 8.1 三级权限策略 (`src/tools/permissions.ts`)

```
INVOX_PERMISSIONS 环境变量
  │
  ├─ "never" (默认) → 全部放行，agent 信任 LLM
  ├─ "writes"        → write + execute tier 需要用户许可
  └─ "always"        → 所有工具都需要用户许可
```

### 8.2 权限请求流程

```
needsPermission(tool.tier, policy) → true ?
  │
  └─ requestPermission(toolName, tier, args, ctx)
       │
       ├─ ACP session/request_permission
       │   options: [Allow (allow_once), Deny (reject_once)]
       │
       ├─ 用户选择 Allow → grant = true → 继续执行
       ├─ 用户选择 Deny → grant = false → 返回 denied 结果
       └─ 请求失败/超时 → 默认 deny
```

### 8.3 Edit 的 read-before-edit 安全网 (`src/tools/edit-file.ts:113-131`)

- Edit 检查 `ctx.state.readPaths.has(path)`
- 如果未读过：自动通过 `readFileWithCache()` 读一次（auto-read），同时标记为已读
- **设计取舍**：当前实现是 auto-read（旧版是硬拒绝），注释说"Edit 的前置闸门"，但实际上会自动补读

### 8.4 工作区边界 (`src/tools/fs-utils.ts:52-67`)

- `isInsideWorkspace()` 判定路径是否在 cwd 内
- 工作区内走 ACP fs（让 Zed 跟踪 dirty buffer、提供 undo）
- 工作区外走 Node 原生 fs（日志 warn）

### 8.5 Agent 模板工具过滤 (`src/agent/templates.ts:621-680`)

```typescript
filterToolSpecsByAgent(specs, allow)
  undefined / ["*"]     → 全部内置工具
  []                    → 禁用全部
  ["Read", "Glob"]      → 严格白名单
  ["-Bash", "-Write"]   → 全集减法模式
```

每个 Agent 模板可独立配置：
- Plan: `["Read", "Glob", "Grep", "Skill", "MakePlan"]`
- Ask: `[]`（无任何工具）
- CodeReviewer: `["Read", "Glob", "Grep", "Bash", "Skill"]`
- Worker: 未设（全部工具 + MCP）

### 8.6 SubAgent 递归屏障

双重保险：
1. `inSubAgent=true` 时，prompt-loop 从 `toolSpecs` 中**剔除 SubAgent 工具** → LLM 看不到
2. `ToolExecContext.subAgentRunner` 为 undefined → 即便 LLM 硬调，execute() 也会 **fail-fast**

---

## 9. 工具调用与其他模块的交互

### 9.1 与日志系统 (`src/log.ts`)

- 每个模块 `createLogger("name")`：`tools` / `prompt-loop` / `agent` / `sub-agent` / `plugins`
- 工具执行的完整生命周期都有 trace 级日志：tool start → args preview → tool end → result preview → elapsedMs
- 每个 session 有独立日志文件（`session-sessionId.log`），SubAgent 有独立日志文件
- 模块过滤：`INVOX_LOG_MODULE=*,-agent` 可关闭 agent 模块的噪音

### 9.2 与 MCP 子系统

```
initMcpForSession(session)
  → 读取 .claude/.mcp.json → 启动 MCP servers → acquire manager
  → session.mcpClient = manager

runOneIteration() 中：
  mcpSpecs = session.mcpClient?.getToolSpecs() ?? []
  allTools = [...builtinSpecs, ...mcpSpecs]

工具执行时：
  mcpTool = session.mcpClient?.getMcpTool(call.name)
  → createMcpTool(mcpTool, manager).execute(args, ctx)
  → manager.callTool(serverName, toolName, args)
```

MCP 工具统一 tier="execute"，inputSchema 直接透传为 OpenAI ToolSpec。

### 9.3 与插件 Hook 系统

```
loadHooks(cwd) → HookRegistry（三级合并：用户 settings → 项目 settings → plugins）

工具执行生命周期中的 hook 触发点：
  1. PreToolUse  → 可拦截（return allow: false）→ 工具不执行
  2. PostToolUse → 成功后可追加 systemMessage 到 resultText
  3. PostToolUseFailure → 失败后可追加 systemMessage
  4. Stop → agent 自然停止时可注入新指令继续 loop

hook 命令协议：
  - stdin: JSON context
  - stdout: JSON response ({ continue, systemMessage })
  - exit code 2 = 阻塞
```

### 9.4 与 Session 持久化

- `prompt()` 结束后自动 `persist()` → `<cwd>/.invox/sessions/<id>.json`
- `SessionToolState`（readPaths + cache）**不持久化**——每次 session 新建或加载时重建
- 工具调用产生的 assistant 消息 + tool 结果消息持久化到 history

### 9.5 与配置系统

环境变量直接控制工具行为：
| 环境变量 | 影响 |
|---|---|
| `INVOX_PERMISSIONS` | 权限策略 |
| `INVOX_MAX_ITERATIONS` | 最大迭代次数（默认 50） |
| `INVOX_SUBAGENT_MAX_ITERATIONS` | SubAgent 最大迭代（默认 25） |
| `INVOX_SHELL` | Bash 工具的 shell 选择 |
| `INVOX_LLM_RETRIES` | LLM 连接重试次数 |
| `INVOX_LOG_MODULE` | 日志模块过滤 |
| `INVOX_MODEL_PRO` / `INVOX_MODEL_LITE` | Agent 模板的 model 占位符 |

---

## 10. 设计亮点

1. **tier 与 uiKind 解耦**：安全维度（read/write/execute）和渲染维度独立，SubAgent 的 `tier=execute, uiKind=other` 是经典案例

2. **递归屏障 belt-and-suspenders**：SubAgent 不能嵌套启动 SubAgent——既在 toolSpecs 层面移除，又在 ToolExecContext 层面移除 runner 闭包

3. **错误不抛出原则**：prompt() 绝不向 ACP RPC 抛异常；runOneToolCall 失败不向调用方抛错；runSubAgent 永不抛错。所有失败都映射为结构化返回值

4. **并行批次调度**：按依赖关系自动切分 parallel/serial 批次；SubAgent 被强制并行（内部再各自串行化），实现多子任务 max(子) 而非 sum(子)

5. **rtk rewrite**：Bash 工具集成了 Rust Token Killer 命令改写（自动探测、缓存、静默回退），实现 60-90% 的 token 节省

6. **conn Proxy 静默**：SubAgent 用 `Proxy` 包装 conn，自动拦截所有 `sessionUpdate` 静默到日志文件，而非 sessionUpdate 通知——保证父 UI 干净

7. **动态 SubAgent 描述**：`buildDynamicSubAgentSpec()` 在每次 iteration 前根据 `agentRegistry` 替换 `{AGENT_LIST}` 占位符，让 LLM 始终看到实际可用的 agent 模板

---

## 11. 潜在问题与关注点

1. **FileCache 不检测会话外修改**（`cache.ts:10-15`）：有意权衡——用户在编辑器里改文件后 LLM 下次 Read 仍可能看到旧缓存。注释说"若证伪，下一步可在 Read 前 stat 文件并比 mtime"。在频繁人机交替编辑的场景下可能造成困惑。

2. **Edit 的 read-before-edit 变为 auto-read**：`edit-file.ts:113-131` 中，如果 LLM 未先 Read 就 Edit，Edit 会自动读一次。这弱化了"强制 read-before-edit"的安全网效果——LLM 可以跳过 Read 直接 Edit，只是会产生一条 `info` 日志。

3. **SubAgent token 不计入父 turnUsage**（`sub-agent-runner.ts:9-12`）：这是有意设计，但意味着 UI token chip 只反映父 LLM 调用的消耗，SubAgent 烧掉的 token 对用户不可见（只在 banner 和日志里）。

4. **Bash 工具无沙箱**：Bash 的 `tier="execute"` 在 `INVOX_PERMISSIONS="never"`（默认）下完全放行，LLM 可执行任意 shell 命令。Worker 模板的 system prompt 虽有安全规则（"Never modify global state"等），但这只是 prompt 级约束。

5. **Hook 命令的同步执行**：多个同步 hook 命令是串行 await 的（`hooks.ts:617-663`），如果一个 hook 命令 timeout 或卡住，会阻塞后续 hook 和工具执行。timeout 有防护但默认无限制。
