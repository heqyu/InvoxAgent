// MCP type definitions shared across the MCP subsystem.

/** One server entry from .claude/.mcp.json → mcpServers. */
export interface McpServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Root shape of .claude/.mcp.json. */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Wraps a single MCP tool — server name, tool name, invox-facing name. */
export interface McpToolDef {
  /** The server key from .claude/.mcp.json (e.g. "codegraph"). */
  serverName: string;
  /** The tool name reported by the MCP server (e.g. "codegraph_search"). */
  toolName: string;
  /** Invox-internal name: mcp__<server>__<tool>. */
  invoxName: string;
  /** The tool's description (may be undefined on servers that omit it). */
  description?: string;
  /**
   * JSON Schema for the tool's arguments. Already sanitised (no $schema,
   * $defs, etc.) and guaranteed to have `type: "object"`.
   */
  inputSchema: Record<string, unknown>;
}
