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
import { InvoxAgent, type AgentModelConfig } from "./agent/agent.js";
import { discoverAllModels } from "./llm/discovery.js";
import { MultiProvider } from "./llm/multi-provider.js";
import type { LLMProvider } from "./llm/types.js";
import { createLogger } from "./log.js";
import { loadProjectSettings } from "./settings.js";
const log = createLogger("cli");
import { disposeAllMcp } from "./mcp/pool.js";
import { StdioTransport } from "./transports/stdio.js";
import type { Transport } from "./transports/types.js";
import { WebSocketTransport } from "./transports/websocket.js";
import type { PermissionPolicy } from "./tools/types.js";
import { pickMockProvider } from "./cli/provider-pick.js";
import type { ProvidersFileConfig } from "./llm/providers.js";
import { pickConfigOptions } from "./cli/config-pick.js";

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
        log.debug("unknown arg ignored", { arg: a });
    }
  }
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
  INVOX_PROMPT_TEMPLATES_FILE     Path to JSON file of system-prompt templates
                                  (only used when INVOX_AGENTS=disabled)
  INVOX_AGENTS                    "disabled" → use legacy system_prompt dropdown
                                  (default: enabled, loads .invox/agents/*.json
                                   + 5 built-in: Plan/Ask/Worker/CodeReviewer/BDD)
  INVOX_AGENTS_DIR                Root directory containing .invox/agents/
                                  (default: process cwd at startup)
  INVOX_DEFAULT_AGENT             Default agent id when multiple are loaded
                                  (default: "Worker" if present, else first)
  INVOX_PLUGIN_DIR                Path to plugin marketplace root (.plugins-cache.json)

MULTI-PROVIDER:
  Configure LLM providers via .invox/providers.json (project-level) or
  ~/.invox/providers.json (user-level). Each provider needs a name, baseUrl,
  and apiKey. On startup, invox pings each provider's /v1/models endpoint
  to discover available models.

  Two-level lookup with field-level merge (project overrides user on conflict):
    1. <cwd>/.invox/providers.json  — project-level
    2. ~/.invox/providers.json      — user-level default

  Merge semantics:
    - providers[]:      deduped by name, project wins
    - defaultModel:     project wins
    - agentModels:      field-merged (PRO / LITE), project wins per key

  agentModels maps agent template placeholders to actual model IDs:
    { "agentModels": { "PRO": "claude-3-5-sonnet", "LITE": "gpt-4o-mini" } }
  Used by "$MODEL_PRO" / "$MODEL_LITE" in agent templates (Plan/CodeReviewer/BDD
  default to PRO; Worker defaults to LITE).

  Falls back to EchoProvider if no providers.json is found.
`,
  );
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

function staticModelsFromConfig(
  providersConfig: ProvidersFileConfig | null,
  fallbackModelIds: string | string[],
): AgentModelConfig {
  const ids: string[] = [];
  const fallbacks = Array.isArray(fallbackModelIds)
    ? fallbackModelIds
    : [fallbackModelIds];
  for (const p of providersConfig?.providers ?? []) {
    for (const id of p.models ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  const preferredDefault = providersConfig?.defaultModel;
  if (ids.length === 0) {
    if (preferredDefault) {
      ids.push(preferredDefault);
    } else {
      ids.push(...fallbacks);
    }
  }
  const defaultModelId =
    preferredDefault && ids.includes(preferredDefault) ? preferredDefault : ids[0]!;

  const proId = providersConfig?.agentModels?.PRO;
  if (proId && !ids.includes(proId)) ids.push(proId);
  const liteId = providersConfig?.agentModels?.LITE;
  if (liteId && !ids.includes(liteId)) ids.push(liteId);

  return {
    available: ids.map((id) => ({ modelId: id, name: id })),
    defaultModelId,
    ...(providersConfig?.agentModels
      ? { agentModels: providersConfig.agentModels }
      : {}),
  };
}

/**
 * Provider + model 联合构建：
 *
 *   1. 读取 providers.json（若存在）作为唯一正式 model menu 来源
 *   2. Mock provider（INVOX_MOCK）只替换 provider，不再通过 env 构造模型菜单
 *   3. Multi-provider（providers.json.providers 非空）—— ping /v1/models 发现模型
 *   4. EchoProvider 兜底（无 providers.json 或只有 agentModels 无 provider 时）
 */
async function buildProviderAndModels(): Promise<{
  provider: LLMProvider;
  models: AgentModelConfig;
}> {
  const providersConfig = (
    await import("./llm/providers.js")
  ).loadProvidersJson(process.cwd());

  const mock = pickMockProvider();
  if (mock) {
    return {
      provider: mock,
      // Mock provider is for deterministic offline tests; keep its model menu
      // isolated from real user/project providers.json.
      models: staticModelsFromConfig(null, ["alpha", "beta"]),
    };
  }

  if (providersConfig && providersConfig.providers.length > 0) {
    log.info("multi-provider: mode active", {
      providerCount: providersConfig.providers.length,
      names: providersConfig.providers.map((p) => p.name),
    });

    const results = await discoverAllModels(providersConfig.providers);

    const multiProvider = new MultiProvider({
      providers: providersConfig.providers.map((c, i) => ({
        config: c,
        discovery: results[i]!,
      })),
      defaultModel: providersConfig.defaultModel,
    });

    const modelList = multiProvider.modelList;
    // agentModels 解析出的 id 自动并入 model 菜单
    const proId = providersConfig.agentModels?.PRO;
    const liteId = providersConfig.agentModels?.LITE;
    const allIds = modelList.map((m) => m.modelId);
    if (proId && !allIds.includes(proId)) {
      modelList.push({ modelId: proId, name: proId, providerName: "agentModels" });
    }
    if (liteId && !allIds.includes(liteId)) {
      modelList.push({ modelId: liteId, name: liteId, providerName: "agentModels" });
    }

    return {
      provider: multiProvider,
      models: {
        available: modelList.map((m) => ({ modelId: m.modelId, name: m.name })),
        defaultModelId: multiProvider.defaultModel,
        agentModels: providersConfig.agentModels,
      },
    };
  }

  log.warn("provider: no usable provider configured, falling back to EchoProvider");
  const { EchoProvider } = await import("./llm/echo.js");
  return {
    provider: new EchoProvider(),
    models: staticModelsFromConfig(providersConfig, "echo-model"),
  };
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

  const { provider, models } = await buildProviderAndModels();
  const policy = pickPolicy();
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

  await Promise.all(
    transports.map((t) =>
      t.start((peer) => {
        new AgentSideConnection(
          (conn) => new InvoxAgent(conn, provider, policy, models, configs),
          peer,
        );
      }),
    ),
  );

  // ── shutdown 逻辑 ──────────────────────────────────────────────
  // 定义在 stdin handler 之前，消除前向引用（J2.5 fix）。
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

  if (args.transports.has("stdio")) {
    process.stdin.on("end", () => {
      log.info("stdin closed, shutting down");
      void shutdownAndExit(0);
    });
  }

  process.on("SIGINT", () => {
    log.info("SIGINT received");
    void shutdownAndExit(130);
  });
  process.on("SIGTERM", () => {
    log.info("SIGTERM received");
    void shutdownAndExit(143);
  });

  if (transports.length > 0) {
    await new Promise<void>(() => {
      /* transports 通过 handle 保活进程 */
    });
  }
}

main().catch((err) => {
  log.error(
    "fatal",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
