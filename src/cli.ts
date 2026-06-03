// Entry point. Selects transport(s) per CLI flags / env, then constructs
// `AgentSideConnection` per peer.
//
// Stages 1-4: stdio + WebSocket. Each peer (1 stdio, N ws clients) gets its
// own InvoxAgent instance for isolation.
//
// Hard rule: nothing here writes to stdout. The stdio transport owns stdout for JSON-RPC.

import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_SYSTEM_PROMPT,
  InvoxAgent,
  type AgentConfigOptions,
  type AgentModelConfig,
  type SystemPromptDef,
} from "./agent/agent.js";
import { EchoProvider } from "./llm/echo.js";
import { MockToolProvider } from "./llm/mock-tools.js";
import { OpenAIProvider } from "./llm/openai.js";
import type { LLMProvider } from "./llm/types.js";
import { log } from "./log.js";
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
        // Unknown flag: ignore for forward-compat; log at debug.
        log.debug("unknown arg ignored", { arg: a });
    }
  }
  // Default: stdio. Zed launches us with no flags, so stdio must be the default.
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
  --ws             Listen for ACP-over-WebSocket clients (stage 4+)
  --port N         WebSocket port (default 9999)
  --host H         WebSocket bind host (default 127.0.0.1)
  -v, --version    Print version and exit
  -h, --help       Print this help and exit

ENVIRONMENT:
  INVOX_LOG                       silent | error | warn | info | debug   (default: info)
  INVOX_BASE_URL                  OpenAI-compatible base URL                              (stage 2+)
  INVOX_MODEL                     Default model name passed to provider                   (stage 2+)
  INVOX_MODELS                    Comma-separated selectable models                       (stage 8+)
  INVOX_API_KEY                   Provider API key                                        (stage 2+)
  INVOX_PROMPT_TEMPLATES_FILE     Path to JSON file of system-prompt templates            (stage 9+)
  INVOX_PLUGIN_DIR                Path to plugin marketplace root (.plugins-cache.json)
`,
  );
}

async function main(): Promise<void> {
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
  });

  const transports: Transport[] = [];
  if (args.transports.has("stdio")) transports.push(new StdioTransport());
  if (args.transports.has("ws")) {
    transports.push(
      new WebSocketTransport({ host: args.wsHost, port: args.wsPort }),
    );
  }

  // Wire each transport: every peer gets its own InvoxAgent instance via the
  // factory passed to AgentSideConnection. This is the per-connection isolation
  // promised in PLAN.md §1.
  await Promise.all(
    transports.map((t) =>
      t.start((peer) => {
        new AgentSideConnection(
          (conn) => new InvoxAgent(conn, provider, policy, models, configs),
          peer,
        );
        // The connection auto-runs once constructed. We hold no reference here
        // because the package keeps it alive via the stream readers.
      }),
    ),
  );

  // Graceful shutdown when stdin closes (Zed disconnects = stdin EOF).
  if (args.transports.has("stdio")) {
    process.stdin.on("end", () => {
      log.info("stdin closed, shutting down");
      process.exit(0);
    });
  }

  // Keep main() alive while transports are bound. stdin reader (stdio) and
  // WebSocketServer (ws) each hold an active handle, so the process won't
  // exit naturally — but the explicit wait makes intent obvious.
  if (transports.length > 0) {
    await new Promise<void>(() => {
      /* transports hold the process open via their handles */
    });
  }
}

/**
 * Provider selection rules:
 *   - INVOX_MOCK=tools                     → MockToolProvider (offline tool-flow tests)
 *   - INVOX_MOCK=1                         → EchoProvider (offline; no tools)
 *   - INVOX_API_KEY + INVOX_BASE_URL set   → OpenAIProvider
 *   - otherwise                            → EchoProvider with a warn
 *
 * INVOX_MODEL defaults to "gpt-4o-mini" if unset (only matters for OpenAIProvider).
 */
function pickProvider(): LLMProvider {
  const mock = process.env["INVOX_MOCK"];
  if (mock === "tools") {
    log.info("provider: mock-tools (INVOX_MOCK=tools)");
    return new MockToolProvider();
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
 * Permission policy selection (stage 5 polish):
 *   - never  (default): no permission requests; agent runs tools directly
 *   - writes: writes/execute go through session/request_permission; reads pass
 *   - always: every tool call is gated
 */
function pickPolicy(): PermissionPolicy {
  const raw = (process.env["INVOX_PERMISSIONS"] ?? "never").toLowerCase();
  if (raw === "writes" || raw === "always" || raw === "never") return raw;
  log.warn(`unknown INVOX_PERMISSIONS=${raw}, defaulting to "never"`);
  return "never";
}

/**
 * Build the model menu advertised to ACP clients.
 *
 * Sources (priority order):
 *   - INVOX_MODELS=id1,id2,id3   — comma-separated user-curated list
 *   - INVOX_MODEL                — falls back as the only / default entry
 *   - hard-coded "gpt-4o-mini"   — final fallback so the menu is never empty
 *
 * Rule: the default model is ALWAYS included in the menu (unshifted to the
 * front if missing). Otherwise a Zed user could land on a session whose
 * "currentModelId" isn't in availableModels and the dropdown would render
 * blank.
 *
 * Naming: `name` shown in the dropdown defaults to the modelId; we keep them
 * identical because OAI-compat providers don't surface friendly names. Users
 * who want a polished label can redefine via separate config later.
 */
function pickModels(): AgentModelConfig {
  const fallback = process.env["INVOX_MODEL"] ?? "gpt-4o-mini";
  const raw = process.env["INVOX_MODELS"] ?? fallback;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!ids.includes(fallback)) ids.unshift(fallback);
  const available: ModelInfo[] = ids.map((id) => ({ modelId: id, name: id }));
  return { available, defaultModelId: fallback };
}

/**
 * Build the AgentConfigOptions surfaced as ACP `setSessionConfigOption`
 * dropdowns. Today this is the System Prompt template selector
 * (the Thinking dropdown is hard-coded inside InvoxAgent — its values
 * are dictated by the OpenAI `reasoning_effort` enum).
 *
 * Source order:
 *   1. `INVOX_PROMPT_TEMPLATES_FILE` — JSON array of `SystemPromptDef`s.
 *      Wins when present and parses cleanly.
 *   2. Built-in 3-template menu (default / concise / review).
 *
 * Failure modes (file missing, malformed JSON, empty array) all warn
 * and fall through to the built-in defaults rather than aborting startup.
 */
function pickConfigOptions(): AgentConfigOptions {
  const systemPrompts = loadPromptTemplates();
  const defaultId = systemPrompts[0]!.id; // Non-null: load() always returns ≥ 1 entry.
  return {
    systemPrompts,
    defaultSystemPromptId: defaultId,
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
