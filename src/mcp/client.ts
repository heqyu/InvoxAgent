// MCP client manager — connects to MCP servers, discovers tools, forwards calls.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import type { McpServerConfig, McpToolDef } from "./types.js";

/** Result JSON payload returned by the MCP server to the client. */
interface McpToolContent {
  type: "text";
  text: string;
}

/**
 * Internal per-server state: the MCP client + transport + a snapshot of
 * this server's tools.
 */
interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDef[];
}

/**
 * Shape of ToolSpec.function.parameters — the subset of JSON Schema that
 * OpenAI's tool-calling API expects.
 */
type OpenAIParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * Owns the lifecycle of one or more MCP servers. Created per-session in
 * InvoxAgent.newSession / loadSession and torn down when the session ends.
 */
export class McpClientManager {
  private servers = new Map<string, ServerEntry>();
  /** Flattened tool defs across all servers, keyed by invoxName. */
  private tools = new Map<string, McpToolDef>();
  /** Pre-computed OpenAI tool specs for all discovered MCP tools. */
  private toolSpecs: ToolSpec[] = [];

  // ---------- public API ----------

  /**
   * Parse configs, spawn child processes, perform the MCP handshake and
   * discover tools. Errors for individual servers are logged but do not
   * prevent other servers (or the session) from working.
   */
  async connect(configs: Record<string, McpServerConfig>): Promise<void> {
    for (const [serverName, cfg] of Object.entries(configs)) {
      if (cfg.type !== "stdio") continue; // only stdio supported
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: cfg.env,
          stderr: "pipe",
        });

        const client = new Client(
          { name: "invox", version: "0.0.1" },
          { capabilities: {} },
        );

        await client.connect(transport);
        log.info("mcp server connected", { server: serverName });

        const { tools } = await client.listTools();
        const defs: McpToolDef[] = [];
        for (const t of tools) {
          const invoxName = `mcp__${serverName}__${t.name}`;
          const def: McpToolDef = {
            serverName,
            toolName: t.name,
            invoxName,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          };
          defs.push(def);
          this.tools.set(invoxName, def);
        }

        this.servers.set(serverName, { client, transport, tools: defs });
        log.info("mcp tools discovered", {
          server: serverName,
          count: defs.length,
        });
      } catch (e) {
        log.warn("mcp server connect failed", {
          server: serverName,
          error: (e as Error).message,
        });
      }
    }

    this.toolSpecs = this.buildToolSpecs();
  }

  /** OpenAI tool specs for all discovered MCP tools. */
  getToolSpecs(): ToolSpec[] {
    return this.toolSpecs;
  }

  /** Look up an MCP tool def by invoxName (mcp__<server>__<tool>). */
  getMcpTool(name: string): McpToolDef | undefined {
    return this.tools.get(name);
  }

  /**
   * Forward a tool call to the appropriate MCP server.
   * Returns the raw result for the tool factory to wrap in a ToolExecResult.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: McpToolContent[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await entry.client.callTool({
      name: toolName,
      arguments: args,
    });

    return {
      content: result.content as McpToolContent[],
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
      isError: result.isError as boolean | undefined,
    };
  }

  /** Shut down all MCP connections and kill subprocesses. */
  async disconnect(): Promise<void> {
    for (const [name, entry] of this.servers) {
      try {
        await entry.transport.close();
        log.info("mcp server disconnected", { server: name });
      } catch (e) {
        log.warn("mcp server disconnect error", {
          server: name,
          error: (e as Error).message,
        });
      }
    }
    this.servers.clear();
    this.tools.clear();
    this.toolSpecs = [];
  }

  // ---------- internal helpers ----------

  /**
   * Convert MCP inputSchema (JSON Schema) to the OpenAI ToolSpec
   * `parameters` shape. Strips MCP-specific fields and ensures `type`,
   * `properties`, and optionally `required` are present.
   */
  private static toOpenAIParameters(
    inputSchema: Record<string, unknown>,
  ): OpenAIParameters {
    const schemaType = inputSchema.type;
    const props =
      inputSchema.properties &&
      typeof inputSchema.properties === "object" &&
      !Array.isArray(inputSchema.properties)
        ? (inputSchema.properties as Record<string, unknown>)
        : {};

    const required = Array.isArray(inputSchema.required)
      ? (inputSchema.required as string[])
      : undefined;

    return {
      type:
        typeof schemaType === "string" && schemaType === "object"
          ? "object"
          : "object",
      properties: props,
      ...(required ? { required } : {}),
    };
  }

  private buildToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const def of this.tools.values()) {
      specs.push({
        type: "function",
        function: {
          name: def.invoxName,
          description:
            def.description ?? `MCP tool: ${def.serverName}/${def.toolName}`,
          parameters: McpClientManager.toOpenAIParameters(def.inputSchema),
        },
      });
    }
    return specs;
  }
}
