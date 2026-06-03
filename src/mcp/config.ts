// Config loader — reads .claude/.mcp.json from a working directory.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import type { McpConfigFile, McpServerConfig } from "./types.js";

/** Parse .claude/.mcp.json from `cwd`. Returns null if absent or invalid. */
export function loadMcpConfig(cwd: string): McpConfigFile | null {
  const path = join(cwd, ".claude", ".mcp.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // file doesn't exist → no MCP servers
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn("mcp config parse error", {
      path,
      error: (e as Error).message,
    });
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("mcpServers" in parsed) ||
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== "object" ||
    Array.isArray(parsed.mcpServers)
  ) {
    log.warn("mcp config missing mcpServers object", { path });
    return null;
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(
    parsed.mcpServers as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      log.warn("mcp config: skipping invalid server entry", {
        path,
        server: name,
      });
      continue;
    }
    const s = entry as Record<string, unknown>;
    if (s.type !== "stdio") {
      log.warn("mcp config: unsupported server type", {
        path,
        server: name,
        type: String(s.type ?? ""),
      });
      continue;
    }
    if (typeof s.command !== "string" || s.command.trim() === "") {
      log.warn("mcp config: server missing command", {
        path,
        server: name,
      });
      continue;
    }

    const config: McpServerConfig = {
      type: "stdio",
      command: s.command,
    };

    if (Array.isArray(s.args)) {
      config.args = s.args.map((a) => String(a));
    }
    if (
      s.env &&
      typeof s.env === "object" &&
      !Array.isArray(s.env)
    ) {
      config.env = Object.fromEntries(
        Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v),
        ]),
      );
    }

    mcpServers[name] = config;
  }

  if (Object.keys(mcpServers).length === 0) return null;

  log.info("mcp config loaded", {
    path,
    servers: Object.keys(mcpServers),
  });
  return { mcpServers };
}
