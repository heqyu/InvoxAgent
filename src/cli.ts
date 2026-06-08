// CLI 入口：根据命令行 / 环境变量挑 transport，给每个对端构造 AgentSideConnection。
//
// stdio + WebSocket 同时可用：每个对端（1 个 stdio 或 N 个 ws 客户端）拿到
// 自己的 InvoxAgent 实例，会话彼此隔离。
//
// **铁律**：本文件绝不写 stdout —— stdio transport 把 stdout 专用于 JSON-RPC 帧。

import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_SYSTEM_PROMPT,
  InvoxAgent,
  type AgentConfigOptions,
  type AgentModelConfig,
  type AgentTemplate,
  type SystemPromptDef,
} from "./agent/agent.js";
import type { ModelInfo } from "./agent/session-types.js";
import {
  loadAgentTemplates,
  readEnvModelLite,
  readEnvModelPro,
} from "./agent/templates.js";
import { EchoProvider } from "./llm/echo.js";
import { FlakyProvider, type FlakyKind } from "./llm/flaky.js";
import { BadJsonProvider, MockToolProvider } from "./llm/mock-tools.js";
import { OpenAIProvider } from "./llm/openai.js";
import type { LLMProvider } from "./llm/types.js";
import { createLogger } from "./log.js";
import { loadProjectSettings } from "./settings.js";
const log = createLogger("cli");
import { disposeAllMcp } from "./mcp/pool.js";
import { StdioTransport } from "./transports/stdio.js";
import type { Transport } from "./transports/types.js";
import { WebSocketTransport } from "./transports/websocket.js";
import type { PermissionPolicy } from "./tools/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Args {
  transports: Set<"stdio" | "ws">;
  wsPort: number;
  wsHost: string;
  showVersion: boolean;
  showHelp: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    transports: new Set(),
    wsPort: 9999,
    wsHost: "127.0.0.1",
    showVersion: false,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--stdio":
        args.transports.add("stdio");
        break;
      case "--ws":
        args.transports.add("ws");
        break;
      case "--port":
        args.wsPort = Number(argv[++i] ?? "9999");
        break;
      case "--host":
        args.wsHost = argv[++i] ?? "127.0.0.1";
        break;
      case "-v":
      case "--version":
        args.showVersion = true;
        break;
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      default:
        // 未知 flag：忽略以保留 forward-compat，仅 debug 级日志。
        log.debug("unknown arg ignored", { arg: a });
    }
  }
  // 默认走 stdio —— Zed 启动 invox 时不带任何 flag，stdio 必须是默认。
  if (args.transports.size === 0) args.transports.add("stdio");
  return args;
}

function pkg(): { name: string; version: string } {
  const p = join(__dirname, "..", "package.json");
  return JSON.parse(readFileSync(p, "utf8")) as {
    name: string;
    version: string;
  };
}

function printHelp(): void {
  const { name, version } = pkg();
  process.stderr.write(
    `${name} v${version} — ACP-compatible agent server

USAGE:
  invox [--stdio] [--ws] [--port N] [--host H]

FLAGS:
  --stdio          Speak ACP over stdio (default if no transport flag given)
  --ws             Listen for ACP-over-WebSocket clients
  --port N         WebSocket port (default 9999)
  --host H         WebSocket bind host (default 127.0.0.1)
  -v, --version    Print version and exit
  -h, --help       Print this help and exit

ENVIRONMENT:
  INVOX_LOG                       silent | error | warn | info | debug   (default: info)
  INVOX_BASE_URL                  OpenAI-compatible base URL
  INVOX_MODEL                     Default model name passed to provider
  INVOX_MODELS                    Comma-separated selectable models
  INVOX_MODEL_PRO                 Model id for "$MODEL_PRO" agent placeholder
                                  (used by Plan / CodeReviewer by default)
                                  alias: MODEL_PRO (without INVOX_ prefix)
  INVOX_MODEL_LITE                Model id for "$MODEL_LITE" agent placeholder
                                  (used by Worker by default)
                                  alias: MODEL_LITE (without INVOX_ prefix)
  INVOX_API_KEY                   Provider API key
  INVOX_PROMPT_TEMPLATES_FILE     Path to JSON file of system-prompt templates
                                  (only used when INVOX_AGENTS=disabled)
  INVOX_AGENTS                    "disabled" → use legacy system_prompt dropdown
                                  (default: enabled, loads .invox/agents/*.json
                                   + 4 built-in: Plan/Ask/Worker/CodeReviewer)
  INVOX_AGENTS_DIR                Root directory containing .invox/agents/
                                  (default: process cwd at startup)
  INVOX_DEFAULT_AGENT             Default agent id when multiple are loaded
                                  (default: "Worker" if present, else first)
  INVOX_PLUGIN_DIR                Path to plugin marketplace root (.plugins-cache.json)
`,
  );
}

async function main(): Promise<void> {
  loadProjectSettings(process.cwd());
  const args = parseArgs(process.argv.slice(2));
  const { name, version } = pkg();

  if (args.showHelp) {
    printHelp();
    return;
  }
  if (args.showVersion) {
    process.stderr.write(`${name} v${version}\n`);
    return;
  }

  const provider = pickProvider();
  const policy = pickPolicy();
  const models = pickModels();
  const configs = pickConfigOptions();
  log.info("starting", {
    name,
    version,
    provider: provider.name,
    policy,
    transports: [...args.transports],
    defaultModel: models.defaultModelId,
    availableModels: models.available.map((m) => m.modelId),
    systemPrompts: configs.systemPrompts.map((p) => p.id),
    defaultSystemPrompt: configs.defaultSystemPromptId,
    agents: configs.agents.map((a) => a.id),
    defaultAgent: configs.defaultAgentId,
  });

  const transports: Transport[] = [];
  if (args.transports.has("stdio")) transports.push(new StdioTransport());
  if (args.transports.has("ws")) {
    transports.push(
      new WebSocketTransport({ host: args.wsHost, port: args.wsPort }),
    );
  }

  // 给每个 transport 接线：每个对端通过工厂获得自己的 InvoxAgent 实例，
  // 这是 PLAN.md §1 所讲的"per-connection 隔离"。
  await Promise.all(
    transports.map((t) =>
      t.start((peer) => {
        new AgentSideConnection(
          (conn) => new InvoxAgent(conn, provider, policy, models, configs),
          peer,
        );
        // AgentSideConnection 构造完成即自动开跑；ACP 包通过 stream readers
        // 把它保活，无需在这里持引用。
      }),
    ),
  );

  // stdin 关闭即 graceful shutdown（Zed 断开 = stdin EOF）。
  if (args.transports.has("stdio")) {
    process.stdin.on("end", () => {
      log.info("stdin closed, shutting down");
      void shutdownAndExit(0);
    });
  }

  // 进程级信号处理：确保任何退出路径都不留 MCP 僵尸子进程。
  //   SIGINT  : Ctrl+C
  //   SIGTERM : kill / supervisord 触发
  let shuttingDown = false;
  const shutdownAndExit = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await disposeAllMcp();
    } catch (e) {
      log.warn("disposeAllMcp failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    process.exit(code);
  };
  process.on("SIGINT", () => {
    log.info("SIGINT received");
    void shutdownAndExit(130);
  });
  process.on("SIGTERM", () => {
    log.info("SIGTERM received");
    void shutdownAndExit(143);
  });

  // 在 transport 绑定期间保活 main()。stdio reader 和 WebSocketServer 都会
  // 持有活动 handle，进程不会自然退出 —— 但显式 wait 让意图更清晰。
  if (transports.length > 0) {
    await new Promise<void>(() => {
      /* transports 通过 handle 保活进程 */
    });
  }
}

/**
 * provider 选择规则：
 *   - INVOX_MOCK=tools                     → MockToolProvider（离线 tool 测试）
 *   - INVOX_MOCK=bad-json                  → BadJsonProvider（验证畸形 JSON 自纠错）
 *   - INVOX_MOCK=flaky                     → FlakyProvider（注入 provider 故障）
 *   - INVOX_MOCK=1                         → EchoProvider（离线，无 tools）
 *   - INVOX_API_KEY + INVOX_BASE_URL 都有  → OpenAIProvider
 *   - 其他                                  → EchoProvider，并 warn 提示
 *
 * INVOX_MODEL 未设置时默认 "gpt-4o-mini"（仅 OpenAIProvider 路径用得到）。
 */
function pickProvider(): LLMProvider {
  const mock = process.env["INVOX_MOCK"];
  if (mock === "tools") {
    log.info("provider: mock-tools (INVOX_MOCK=tools)");
    return new MockToolProvider();
  }
  if (mock === "bad-json") {
    log.info("provider: mock-bad-json (INVOX_MOCK=bad-json)");
    return new BadJsonProvider();
  }
  if (mock === "flaky") {
    // 故障种类由 INVOX_FLAKY_KIND 控制：429 / 500 / auth / network / mid-stream
    const kind = (process.env["INVOX_FLAKY_KIND"] ?? "429") as FlakyKind;
    log.info("provider: mock-flaky", { kind });
    return new FlakyProvider(kind);
  }
  if (mock === "1") {
    log.info("provider: echo (INVOX_MOCK=1)");
    return new EchoProvider();
  }
  const apiKey = process.env["INVOX_API_KEY"];
  const baseURL = process.env["INVOX_BASE_URL"];
  if (apiKey && baseURL) {
    const model = process.env["INVOX_MODEL"] ?? "gpt-4o-mini";
    log.info("provider: openai", { baseURL, model });
    return new OpenAIProvider({ apiKey, baseURL, model });
  }
  log.warn(
    "provider: echo (INVOX_API_KEY or INVOX_BASE_URL missing — set both for real LLM)",
  );
  return new EchoProvider();
}

/**
 * 权限策略选择：
 *   - never  (默认)：不发起权限请求，agent 直接跑工具
 *   - writes：write / execute 走 session/request_permission；read 直接通过
 *   - always：每次工具调用都过权限闸门
 */
function pickPolicy(): PermissionPolicy {
  const raw = (process.env["INVOX_PERMISSIONS"] ?? "never").toLowerCase();
  if (raw === "writes" || raw === "always" || raw === "never") return raw;
  log.warn(`unknown INVOX_PERMISSIONS=${raw}, defaulting to "never"`);
  return "never";
}

/**
 * 构造对客户端公布的 model 菜单。
 *
 * 来源（优先级从高到低）：
 *   - INVOX_MODELS=id1,id2,id3  —— 用户自定义列表
 *   - INVOX_MODEL                —— 唯一 / 默认条目兜底
 *   - 写死 "gpt-4o-mini"          —— 终极兜底，保证菜单非空
 *
 * 规则：默认 model **永远**出现在菜单里（不在则被 unshift 到首位）。否则 Zed
 * 用户可能落到一个 currentModelId 不在 availableModels 的会话，UI 下拉框空白。
 *
 * Phase H：把 INVOX_MODEL_PRO / INVOX_MODEL_LITE 解析后的实际值自动并入
 * 菜单（如果它们已设置且不重复）。这样 agent.model="$MODEL_PRO" 切换时，
 * 解析出的 model id 一定能在下拉里找到，不会出现"切了但 UI 不显示"的别扭。
 *
 * name 字段默认就用 modelId —— OAI 兼容 provider 不会上报友好显示名；
 * 想要更好看的标签可以后续单独加配置。
 */
function pickModels(): AgentModelConfig {
  const fallback = process.env["INVOX_MODEL"] ?? "gpt-4o-mini";
  const raw = process.env["INVOX_MODELS"] ?? fallback;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!ids.includes(fallback)) ids.unshift(fallback);

  // INVOX_MODEL_PRO / INVOX_MODEL_LITE：作为 agent.model 占位符引用的目标，
  // 把它们解析后的实际 id 也并入 menu。
  const proId = readEnvModelPro();
  if (proId && !ids.includes(proId)) ids.push(proId);
  const liteId = readEnvModelLite();
  if (liteId && !ids.includes(liteId)) ids.push(liteId);

  const available: ModelInfo[] = ids.map((id) => ({ modelId: id, name: id }));
  return { available, defaultModelId: fallback };
}

/**
 * 构造 ACP `setSessionConfigOption` 暴露的下拉项。
 *
 * Phase G 路径选择：
 *   - 检测到任何 agent 模板（项目级 / 用户级 / 内置兜底）→ 走 Agent 路径，
 *     `setSessionConfigOption` 暴露 "Agent" 下拉，每个 agent 自带 prompt +
 *     工具白名单 + MCP 开关。systemPrompts 仍存于配置内但不会被暴露。
 *   - 用户显式 `INVOX_AGENTS=disabled` → agents 数组为空，回退旧 system_prompt 路径
 *
 * Agent 模板加载源（高 → 低优先）：
 *   1. <agentScanCwd>/.invox/agents/*.json  —— 项目级
 *      其中 agentScanCwd = INVOX_AGENTS_DIR（若设）或 process.cwd()
 *      （Zed 启动 invox 时 cwd 通常即用户项目根）
 *   2. ~/.invox/agents/*.json                 —— 用户级
 *   3. BUILTIN_AGENTS                         —— Plan / Ask / Worker / CodeReviewer 4 套
 *
 * 失败模式（文件缺失 / JSON 损坏 / 空数组）一律 warn 并回退到内置模板，
 * 不让启动卡死。
 */
function pickConfigOptions(): AgentConfigOptions {
  const systemPrompts = loadPromptTemplates();
  const defaultSystemPromptId = systemPrompts[0]!.id; // load() 总能返回 ≥ 1 条

  // INVOX_AGENTS=disabled 用作"我就要用旧 system_prompt 下拉"的逃生阀
  const agentsDisabled =
    (process.env["INVOX_AGENTS"] ?? "").toLowerCase() === "disabled";

  let agents: AgentTemplate[] = [];
  let defaultAgentId: string | undefined;
  if (!agentsDisabled) {
    // 优先用 INVOX_AGENTS_DIR 覆盖扫描根 —— 测试 / 多项目场景下让用户显式
    // 指向 .invox/agents/ 的父目录。未设则用进程 cwd（生产场景下 Zed 启动
    // invox 时 cwd 通常是用户项目根）。
    const scanRoot = process.env["INVOX_AGENTS_DIR"] ?? process.cwd();
    agents = loadAgentTemplates(scanRoot);
    if (agents.length > 0) {
      // 选首项作为默认：项目级文件总在最前，用户期望"放在最上面的 agent
      // 就是默认"。允许用 INVOX_DEFAULT_AGENT 显式覆盖。
      const envDefault = process.env["INVOX_DEFAULT_AGENT"];
      if (envDefault && agents.some((a) => a.id === envDefault)) {
        defaultAgentId = envDefault;
      } else {
        // 内置 4 套时优先选 Worker（最通用），否则选首项
        defaultAgentId =
          agents.find((a) => a.id === "Worker")?.id ?? agents[0]!.id;
      }
    }
  }

  return {
    systemPrompts,
    defaultSystemPromptId,
    agents,
    ...(defaultAgentId ? { defaultAgentId } : {}),
  };
}

const BUILTIN_SYSTEM_PROMPTS: SystemPromptDef[] = [
  {
    id: "default",
    name: "Default",
    description: "Helpful coding assistant — uses tools first, explains after.",
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    id: "concise",
    name: "Concise",
    description: "Brief responses with minimal narration.",
    prompt:
      `You are a coding assistant in Zed. Be brief.\n` +
      `Use tools first; explain only when asked. Reply in 1-3 sentences unless code is required.`,
  },
  {
    id: "review",
    name: "Strict Review",
    description:
      "Adversarial code reviewer — quotes file paths and flags risks.",
    prompt:
      `You are a senior code reviewer in Zed. Adopt a skeptical, evidence-first stance.\n` +
      `Always quote file paths and line numbers. Flag risks before suggesting changes. ` +
      `Read code with the Read tool before commenting on it.`,
  },
];

function loadPromptTemplates(): SystemPromptDef[] {
  const file = process.env["INVOX_PROMPT_TEMPLATES_FILE"];
  if (!file) return BUILTIN_SYSTEM_PROMPTS;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      log.warn(
        `INVOX_PROMPT_TEMPLATES_FILE: parsed value is not a non-empty array; using built-in templates`,
        { file },
      );
      return BUILTIN_SYSTEM_PROMPTS;
    }
    const out: SystemPromptDef[] = [];
    for (const entry of parsed) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { id?: unknown }).id !== "string" ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        typeof (entry as { prompt?: unknown }).prompt !== "string"
      ) {
        log.warn("INVOX_PROMPT_TEMPLATES_FILE: skipping invalid entry", {
          entry,
        });
        continue;
      }
      const e = entry as {
        id: string;
        name: string;
        description?: string;
        prompt: string;
      };
      out.push({
        id: e.id,
        name: e.name,
        ...(typeof e.description === "string"
          ? { description: e.description }
          : {}),
        prompt: e.prompt,
      });
    }
    if (out.length === 0) {
      log.warn(
        "INVOX_PROMPT_TEMPLATES_FILE: no valid entries after filtering; using built-in templates",
        { file },
      );
      return BUILTIN_SYSTEM_PROMPTS;
    }
    return out;
  } catch (err) {
    log.warn(
      "INVOX_PROMPT_TEMPLATES_FILE: load failed; using built-in templates",
      {
        file,
        err: err instanceof Error ? err.message : String(err),
      },
    );
    return BUILTIN_SYSTEM_PROMPTS;
  }
}

main().catch((err) => {
  log.error(
    "fatal",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
