# InvoxAgent — Agent 循环机制深度分析

## Goal
深入分析 InvoxAgent 项目中的 "Agent 循环" 机制，梳理其架构设计、数据流和关键步骤。

---

## 一、项目概况

- **语言**: TypeScript (Node.js ESM)
- **框架**: 无前端框架，基于 `@agentclientprotocol/sdk`（ACP 协议 SDK）和 `openai` SDK 构建
- **定位**: ACP 兼容的 Agent 服务器，可作为 Zed 编辑器的后端 Agent 服务
- **协议**: 实现 Agent Client Protocol (ACP)，支持 stdio 和 WebSocket 两种传输层
- **LLM 后端**: OpenAI 兼容 API（支持 echo/mock/flaky 等测试 Provider）

---

## 二、Agent 循环的入口与核心文件

| 文件 | 角色 |
|------|------|
| `src/cli.ts` | CLI 入口，初始化 Provider / Transport / Agent，启动监听 |
| `src/agent/agent.ts` | `InvoxAgent` 类，实现 ACP `Agent` 接口，管理 session 生命周期 |
| `src/agent/prompt-loop.ts` | **核心循环**：单轮 LLM ↔ tool 往返的实现 |
| `src/agent/sub-agent-runner.ts` | 子 Agent runner：嵌套循环，启动独立 prompt loop |
| `src/tools/router.ts` | 工具调度器，解析参数→权限→执行 |
| `src/tools/registry.ts` | 工具注册表，注册所有 9 个内置工具 |
| `src/llm/types.ts` | LLM Provider 抽象接口定义 |
| `src/llm/openai.ts` | OpenAI 兼容 LLM Provider 实现 |
| `src/plugins/hooks.ts` | 插件钩子系统（PreToolUse / PostToolUse / Stop 等） |
| `src/agent/session-types.ts` | Session、TurnUsage 等核心类型定义 |

---

## 三、循环流程的关键步骤和数据流

### 3.1 顶层循环：`prompt()` 方法
**位置**: `src/agent/agent.ts:639-838`

```
用户发送 PromptRequest
    │
    ▼
┌─ prompt() ──────────────────────────────────────────────┐
│ 1. 查找 session，重置 turnUsage / AbortController       │
│ 2. 构建 userContent，追加到 history                     │
│ 3. 运行 UserPromptSubmit hook（可拦截 prompt）          │
│ 4. 如果 hook 注入 systemMessage，合并到 history[0]      │
│ 5. 进入 for 循环（最多 MAX_ITERATIONS 次，默认 50）:   │
│    │                                                    │
│    ├─▶ runOneIteration(session)                          │
│    │     │                                              │
│    │     ├─ 返回 "stop" → break（end_turn/cancelled）    │
│    │     ├─ 返回 "stop" + refusal → break               │
│    │     └─ 返回 "continue" → 继续循环                  │
│    │                                                    │
│    ├─ 如果 result.reason === "end_turn":                 │
│    │   运行 Stop hook → 可能注入 systemMessage → continue│
│    │                                                    │
│    └─ 检查 abort signal → cancelled                     │
│                                                          │
│ 6. finally: reportTurnUsage + 持久化 session            │
│ 7. 返回 PromptResponse (stopReason + usage)             │
└─────────────────────────────────────────────────────────┘
```

### 3.2 单次迭代：`runOneIteration()`
**位置**: `src/agent/prompt-loop.ts:170-300`

```
runOneIteration(session, deps)
    │
    ├─ 1. 构建工具集：
    │     ├─ 内置工具 → filterToolSpecsByAgent() 按 agent 模板过滤
    │     ├─ SubAgent 递归屏障：inSubAgent=true 时剔除 SubAgent
    │     ├─ MCP 工具 → agentAllowsMcp() 控制开关
    │     └─ 合并 builtinSpecs + mcpSpecs
    │
    ├─ 2. 流式调用 LLM：
    │     deps.provider.stream({messages, signal, tools, model, reasoningEffort})
    │     │
    │     ├─ delta.kind === "text"  → 累加 assistantText + emit agent_message_chunk
    │     ├─ delta.kind === "tool_call" → 收集到 toolCalls 数组
    │     ├─ delta.kind === "usage" → accumulateTurnUsage()
    │     └─ delta.kind === "finish" → 记录 finishReason
    │
    ├─ 3. 错误处理（try-catch 包裹整个 stream）：
    │     ├─ AbortError → cancelled
    │     └─ 其他 → classifyProviderError() → refusal
    │
    ├─ 4. 判断终止条件：
    │     ├─ abort signal → cancelled
    │     ├─ 无 tool_calls 或 finishReason !== "tool_calls" → end_turn
    │     └─ 有 tool_calls → 继续执行
    │
    └─ 5. 执行工具调用：
          executeToolCallBatches(toolCalls, session, deps)
          → 返回 { kind: "continue" }
```

### 3.3 工具执行批次：`executeToolCallBatches()`
**位置**: `src/agent/prompt-loop.ts:303-330`

```
planToolCallBatches(toolCalls)
    │
    ├─ 只读工具 (Read/Glob/Grep/Skill) → 并行批次
    ├─ SubAgent → 并行批次（PARALLEL_SAFE_OVERRIDE）
    ├─ Bash/Edit/Write/MakePlan → 串行（顺序屏障）
    └─ MCP 工具/未知工具 → 串行

并行批次 → Promise.all(runs)
串行批次 → 逐个 await runOneToolCall()
```

### 3.4 单个工具调用：`runOneToolCall()`
**位置**: `src/agent/prompt-loop.ts:339-552`

```
runOneToolCall(call, session, deps)
    │
    ├─ 1. emit tool_call (in_progress) 通知
    ├─ 2. parseToolArguments() → 容错解析 JSON 参数
    ├─ 3. PreToolUse hook → 可拒绝工具调用
    ├─ 4. 构造 ToolExecContext (含 subAgentRunner 闭包)
    ├─ 5. 执行工具：
    │     ├─ MCP 工具 → createMcpTool().execute()
    │     └─ 内置工具 → executeTool(name, rawArgs, ctx)
    ├─ 6. PostToolUse / PostToolUseFailure hook → 可注入额外 systemMessage
    ├─ 7. emit tool_call_update (completed/failed)
    └─ 8. 返回 LLMMessage {role:"tool", content, tool_call_id, name}
```

### 3.5 工具调度器：`executeTool()`
**位置**: `src/tools/router.ts:19-57`

```
executeTool(name, rawArgs, ctx)
    │
    ├─ getTool(name) → 查注册表
    ├─ parseToolArguments(rawArgs) → 二次解析（防御性）
    ├─ needsPermission(tool.tier, policy) → 权限闸门
    │     └─ requestPermission() → ACP session/request_permission
    └─ tool.execute(args, ctx) → 真正执行
```

---

## 四、重要的设计模式与架构决策

### 4.1 依赖注入模式（IterationDeps）
`prompt-loop.ts` 的 `runOneIteration()` 不持有 `InvoxAgent` 实例引用。所有外部状态通过 `IterationDeps` 接口注入：
- `conn`（ACP 连接）
- `provider`（LLM）
- `policy`（权限策略）
- `buildHookBase`（回调工厂）
- `activeAgent`（当前 agent 模板）
- `agentRegistry`（全局 agent 注册表）

这使得 prompt-loop 可独立单测、mock。

### 4.2 Discriminated Union 返回值
`IterationResult` 使用判别联合：
- `{ kind: "stop", reason: "end_turn" }` — LLM 自然结束
- `{ kind: "stop", reason: "cancelled" }` — 用户取消
- `{ kind: "stop", reason: "refusal", error }` — Provider 错误
- `{ kind: "continue" }` — 有工具调用，循环继续

**调用方不抛异常**——错误已在内部吸收。

### 4.3 SubAgent 递归屏障
双重保险防止递归爆炸：
1. `inSubAgent=true` 时从工具集中剔除 SubAgent 工具（LLM 看不到）
2. `inSubAgent=true` 时不注入 `subAgentRunner`（即使 LLM 硬调也会 fail-fast）

### 4.4 并行工具执行
- 只读工具（`tier="read"`）和 SubAgent 可并行（`Promise.all`）
- 写入/执行类工具串行执行
- 避免共享可变状态冲突

### 4.5 Hook 系统（插件钩子）
5 个 hook 点，贯穿整个循环生命周期：
- `SessionStart` — 会话创建时
- `UserPromptSubmit` — 用户提交 prompt 前（可拦截）
- `PreToolUse` — 工具执行前（可拒绝）
- `PostToolUse` / `PostToolUseFailure` — 工具执行后（可注入内容）
- `Stop` — LLM 自然结束时（可注入 systemMessage 继续循环）

### 4.6 流式架构
LLM 响应通过 `AsyncIterable<LLMDelta>` 流式处理：
- `text` delta → 实时 emit 到客户端（`agent_message_chunk`）
- `tool_call` delta → 在 provider 内部累积完整参数后才 emit（避免分片丢失）
- `usage` delta → 累积到 turnUsage
- `finish` delta → 判断是否需要继续循环

### 4.7 Session 隔离
- 每个 ACP 连接创建独立的 `InvoxAgent` 实例
- 每个 session 有独立的 `history` / `toolState` / `abort` / `turnUsage` / `hooks`
- 同 cwd 的 session 共享 MCP 进程池

---

## 五、完整数据流图

```
Zed 客户端
    │
    │ ACP JSON-RPC (stdio / WebSocket)
    ▼
┌─ cli.ts ─────────────┐
│  StdioTransport       │
│  WebSocketTransport   │
└────────┬─────────────┘
         │
         ▼
┌─ InvoxAgent (agent.ts) ──────────────────────────────────────┐
│                                                               │
│  prompt() ─→ 拦截 hook ─→ history.push(user)                 │
│      │                                                         │
│      ▼                                                         │
│  ┌─ for (iter < 50) ─────────────────────────────────────┐   │
│  │                                                         │   │
│  │  runOneIteration()  ─── prompt-loop.ts ───────────┐   │   │
│  │      │                                              │   │   │
│  │      ▼                                              │   │   │
│  │  provider.stream(history, tools)                    │   │   │
│  │      │                                              │   │   │
│  │      ├─ text chunks ──→ agent_message_chunk ──→ Zed│   │   │
│  │      ├─ tool_calls   ──→ collected                  │   │   │
│  │      └─ finish        ──→ check                     │   │   │
│  │                                                      │   │   │
│  │  [有 tool_calls?]                                    │   │   │
│  │      │ YES                                           │   │   │
│  │      ▼                                               │   │   │
│  │  planToolCallBatches()                               │   │   │
│  │      │                                               │   │   │
│  │      ├─ parallel: [Read, Glob, Grep, SubAgent]       │   │   │
│  │      │   └─ Promise.all → tool results               │   │   │
│  │      │                                               │   │   │
│  │      └─ serial: [Bash, Edit, Write]                  │   │   │
│  │          └─ await → tool results                     │   │   │
│  │                                                      │   │   │
│  │  tool results ──→ history.push(tool messages)        │   │   │
│  │                                                      │   │   │
│  │  return { kind: "continue" } ──→ 下一轮 iter        │   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Stop hook → 可能 continue                                   │
│  reportTurnUsage → emit usage_update                        │
│  persist → 写入 .invox/sessions/<id>.json                   │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、关键文件路径列表

1. **`src/cli.ts`** — CLI 入口，Transport/Provider/Agent 初始化
2. **`src/agent/agent.ts`** — `InvoxAgent` 类，ACP 协议入口，顶层 `prompt()` 循环
3. **`src/agent/prompt-loop.ts`** — 核心：`runOneIteration()`，单轮 LLM↔tool 往返
4. **`src/agent/sub-agent-runner.ts`** — SubAgent 嵌套循环实现
5. **`src/agent/session-types.ts`** — Session / HookBase / TurnUsage 类型定义
6. **`src/agent/usage-meter.ts`** — TurnUsage 累加器
7. **`src/agent/system-prompt.ts`** — 系统提示词构建
8. **`src/agent/templates.ts`** — Agent 模板加载与过滤
9. **`src/agent/error-mapping.ts`** — Provider 错误分类映射
10. **`src/agent/tool-presentation.ts`** — 工具调用的 UI 展示辅助
11. **`src/llm/types.ts`** — LLMProvider / LLMDelta / ToolSpec 类型定义
12. **`src/llm/openai.ts`** — OpenAI Provider 实现
13. **`src/tools/router.ts`** — 工具调度器
14. **`src/tools/registry.ts`** — 9 个内置工具注册表
15. **`src/tools/types.ts`** — Tool / ToolExecContext / ToolExecResult 类型
16. **`src/plugins/hooks.ts`** — 插件钩子系统
17. **`src/tools/sub-agent.ts`** — SubAgent 工具定义（工具层）
18. **`src/mcp/tool.ts`** — MCP 工具适配器
19. **`src/transports/stdio.ts`** — stdio 传输层
20. **`src/transports/websocket.ts`** — WebSocket 传输层

---

## 七、补充说明

### 7.1 内置 9 个工具
| 工具名 | 风险等级 | 并行安全 | 说明 |
|--------|---------|---------|------|
| ReadFile | read | ✅ | 读文件 |
| WriteFile | write | ❌ | 写文件 |
| EditFile | write | ❌ | 编辑文件 |
| MakePlan | write | ❌ | 保存计划 |
| Glob | read | ✅ | 文件搜索 |
| Grep | read | ✅ | 内容搜索 |
| Bash | execute | ❌ | 执行命令 |
| Skill | read | ✅ | 技能调用 |
| SubAgent | execute | ✅(override) | 子 Agent 启动 |

### 7.2 消息历史结构
`session.history` 数组的结构：
```
[0] system   — 系统提示词（含 memory/skills 段）
[1] user     — 第一条用户消息
[2] assistant + tool_calls — LLM 回复含工具调用
[3..N] tool  — 工具结果
[4..N] assistant — LLM 基于工具结果的回复
...循环...
```

### 7.3 终止条件汇总
循环在以下情况终止：
1. LLM 无 tool_calls（`finishReason === "stop"`）→ `end_turn`
2. 用户 abort → `cancelled`
3. 达到 MAX_ITERATIONS（默认 50）→ `max_turn_requests`
4. Provider 错误 → `refusal`
5. Stop hook 拒绝后循环继续（注入新 user message），但仅限一次（`stopHookActive` 机制）
