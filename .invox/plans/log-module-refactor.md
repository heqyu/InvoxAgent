# 日志系统重构：增加 date level module 三重显示 + 模块过滤

## Goal

将 `src/log.ts` 的输出格式从 `date [level] msg` 升级为 `date [level] [module] msg`，并新增环境变量 `INVOX_LOG_MODULE` 控制哪些模块输出日志，支持 `*`(全打印)、`[]`(全静默)、`[aa,bb]`(白名单)、`[*,-aa]`(黑名单) 语法。

## Findings

### 现有日志系统结构
- **入口**: `src/log.ts` — 唯一日志模块，110 行
- **导出**: `log` 对象含 `error/warn/info/debug/trace/isEnabled` 6 个方法 (`:100-109`)
- **格式**: `MM-DD HH:mm:ss.SSS [level] msg` (`:83-86`)
- **输出**: stderr + 可选文件 (`INVOX_LOG_FILE`) (`:87-89`)
- **级别控制**: `INVOX_LOG` 环境变量 (`:28`)
- **无模块概念**: 所有调用者共享同一个 `log` 对象

### 调用者分布 (25 个文件)
现有代码已通过消息前缀隐含模块信息：

| 模块名 | 文件 | 典型前缀 |
|--------|------|----------|
| `cli` | `src/cli.ts` | "starting", "stdin closed" |
| `agent` | `src/agent/agent.ts` | "initialize", "session created" |
| `prompt-loop` | `src/agent/prompt-loop.ts` | "tool batch start", "provider stream failed" |
| `templates` | `src/agent/templates.ts` | "agents:" |
| `mcp-lifecycle` | `src/agent/mcp-lifecycle.ts` | "mcp connected" |
| `llm` | `src/llm/openai.ts` | "llm:" |
| `transport` | `src/transports/{ws,stdio}.ts` | "ws:", "stdio" |
| `persistence` | `src/persistence.ts` | "session" |
| `discovery` | `src/discovery/{index,memory-providers}.ts` | "discovery:" |
| `plugins` | `src/plugins/{loader,hooks}.ts` | "plugins:" |
| `mcp` | `src/mcp/{client,pool,config}.ts` | "mcp:" |
| `tools` | `src/tools/{bash,edit-file,write-file,read-file,glob,grep,make-plan,skill,router,permissions}.ts` | "tool:", "Bash:", "Edit:", etc. |

### 关键约束
- **stdout 不可写** — 所有日志必须走 stderr (`CLAUDE.md:66`)
- **性能敏感** — `isEnabled(level)` 用于跳过昂贵 payload 准备 (`:107-109`)
- **零依赖** — 当前 log.ts 仅依赖 `node:fs`

## Proposed changes

### 1. `src/log.ts` — 核心重构 (L)

改动点：
- **新增 `createLogger(module)` 工厂函数** — 返回带模块标识的 log 接口
  - 每个模块调用 `createLogger("agent")` 得到独立 logger
  - 保留原有 `log` 导出作为无模块的默认 logger（向后兼容，显示为 `[core]`）

- **新增模块过滤逻辑**:
  ```ts
  // 解析 INVOX_LOG_MODULE 环境变量
  // "*"          → 全部通过（默认值）
  // "" 或 "[]"   → 全部静默
  // "aa,bb"      → 仅 aa、bb 通过
  // "*,-aa,-bb"  → 除了 aa、bb 都通过
  function parseModuleFilter(raw: string): (mod: string) => boolean
  ```

- **修改 `emit` 函数签名** — 增加 `module: string` 参数
  - 格式变更: `${ts} [${level}] [${module}] ${msg}` (`:83-86`)

- **修改 `isEnabled`** — 增加 module 维度判断
  ```ts
  isEnabled(level, module): boolean {
    return levelOK && moduleFilter(module);
  }
  ```

- **新增 `INVOX_LOG_MODULE` 环境变量读取**

### 2. 25 个调用者文件 — 批量替换 `log` 为模块 logger (M each, 每文件 ~5-10 行)

每个文件头部改为：
```ts
import { createLogger } from "../log.js";
const log = createLogger("module-name");
```

模块分配：

| 文件 | module 名 |
|------|-----------|
| `src/cli.ts` | `cli` |
| `src/agent/agent.ts` | `agent` |
| `src/agent/prompt-loop.ts` | `prompt-loop` |
| `src/agent/templates.ts` | `templates` |
| `src/agent/mcp-lifecycle.ts` | `mcp-lifecycle` |
| `src/agent/system-prompt.ts` | `agent` |
| `src/agent/error-mapping.ts` | `agent` |
| `src/agent/tool-presentation.ts` | `agent` |
| `src/agent/token-meter.ts` | `agent` |
| `src/agent/replay-history.ts` | `agent` |
| `src/llm/openai.ts` | `llm` |
| `src/llm/backoff.ts` | `llm` |
| `src/transports/websocket.ts` | `transport` |
| `src/transports/stdio.ts` | `transport` |
| `src/persistence.ts` | `persistence` |
| `src/discovery/index.ts` | `discovery` |
| `src/discovery/memory-providers.ts` | `discovery` |
| `src/plugins/loader.ts` | `plugins` |
| `src/plugins/hooks.ts` | `plugins` |
| `src/mcp/client.ts` | `mcp` |
| `src/mcp/pool.ts` | `mcp` |
| `src/mcp/config.ts` | `mcp` |
| `src/tools/bash.ts` | `tools` |
| `src/tools/edit-file.ts` | `tools` |
| `src/tools/write-file.ts` | `tools` |
| `src/tools/read-file.ts` | `tools` |
| `src/tools/glob.ts` | `tools` |
| `src/tools/grep.ts` | `tools` |
| `src/tools/make-plan.ts` | `tools` |
| `src/tools/skill.ts` | `tools` |
| `src/tools/router.ts` | `tools` |
| `src/tools/permissions.ts` | `tools` |
| `src/tools/cache.ts` | `tools` |

### 3. 测试 — `tests/unit/log.test.ts` (M)

测试项：
- `createLogger` 返回的 logger 输出包含 `[module]`
- `INVOX_LOG_MODULE=*` → 全部通过
- `INVOX_LOG_MODULE=[]` → 全部静默
- `INVOX_LOG_MODULE=[agent,llm]` → 仅 agent、llm 通过
- `INVOX_LOG_MODULE=[*,-agent]` → 除了 agent 都通过
- `isEnabled()` 正确考虑 level + module 双重过滤
- 无 `INVOX_LOG_MODULE` 时默认全部通过

### 4. 文档更新 (S)

- `README.md:165-167` — 新增 `INVOX_LOG_MODULE` 行
- `CLAUDE.md:112` — 补充模块过滤说明
- `src/log.ts` 头部注释 — 更新使用说明

## Risks

1. **`isEnabled` 签名变更** — 所有 `log.isEnabled(level)` 调用需加上 module 参数（grep 确认仅 `src/llm/openai.ts:36` 一处调用）
2. **测试中的 `INVOX_LOG` mock** — `examples/*.ts` 和 `tests/integration/smoke.test.ts` 通过 env 设置 `INVOX_LOG`，不受影响但需确认 `INVOX_LOG_MODULE` 默认行为不影响现有测试
3. **消息前缀冗余** — 重构后 `"llm: request"` 会变成 `[llm] llm: request`，需清理 25 个文件中的旧前缀文本（建议分批清理，不在本次强制要求）

## Open questions

1. **模块粒度** — `tools` 下 10 个文件是否需要更细粒度（如 `tool-bash`、`tool-edit`）？当前方案统一用 `tools`，需要时再拆分
2. **`log` 默认导出保留** — 是否保留 `export const log` 无模块版本用于 `log.ts` 内部自用（如 fileStream 错误）？建议保留为 `[core]`
3. **消息前缀清理** — 是否在本次一并去掉消息中已有的模块前缀（如 `"llm: request"` → `"request"`）？建议是，避免 `[llm] llm: request` 冗余
