// Entry point. Selects transport(s) per CLI flags / env, then constructs
// `AgentSideConnection` per peer.
//
// Stages 1-4: stdio + WebSocket. Each peer (1 stdio, N ws clients) gets its
// own InvoxAgent instance for isolation.
//
// Hard rule: nothing here writes to stdout. The stdio transport owns stdout for JSON-RPC.

import { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InvoxAgent } from "./agent/agent.js";
import { EchoProvider } from "./llm/echo.js";
import { MockToolProvider } from "./llm/mock-tools.js";
import { OpenAIProvider } from "./llm/openai.js";
import type { LLMProvider } from "./llm/types.js";
import { log } from "./log.js";
import { StdioTransport } from "./transports/stdio.js";
import type { Transport } from "./transports/types.js";
import { WebSocketTransport } from "./transports/websocket.js";
import type { PermissionPolicy } from "./tools/router.js";

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
  return JSON.parse(readFileSync(p, "utf8")) as { name: string; version: string };
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
  INVOX_LOG        silent | error | warn | info | debug   (default: info)
  INVOX_BASE_URL   OpenAI-compatible base URL              (stage 2+)
  INVOX_MODEL      Model name to send to provider          (stage 2+)
  INVOX_API_KEY    Provider API key                        (stage 2+)
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
  log.info("starting", {
    name,
    version,
    provider: provider.name,
    policy,
    transports: [...args.transports],
  });

  const transports: Transport[] = [];
  if (args.transports.has("stdio")) transports.push(new StdioTransport());
  if (args.transports.has("ws")) {
    transports.push(new WebSocketTransport({ host: args.wsHost, port: args.wsPort }));
  }

  // Wire each transport: every peer gets its own InvoxAgent instance via the
  // factory passed to AgentSideConnection. This is the per-connection isolation
  // promised in PLAN.md §1.
  await Promise.all(
    transports.map((t) =>
      t.start((peer) => {
        new AgentSideConnection((conn) => new InvoxAgent(conn, provider, policy), peer);
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

main().catch((err) => {
  log.error("fatal", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
