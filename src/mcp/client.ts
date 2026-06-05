// MCP client manager —— 连接 MCP 服务器、发现工具、转发调用。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLogger } from "../log.js";
const log = createLogger("mcp");
import type { ToolSpec } from "../llm/types.js";
import type { McpServerConfig, McpToolDef } from "./types.js";

/** MCP 服务器返回的结果 payload。 */
interface McpToolContent {
  type: "text";
  text: string;
}

/** 单个 server 的内部状态：MCP client + transport + 工具快照。 */
interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDef[];
}

/** ToolSpec.function.parameters 的形状 —— OpenAI tool calling 期望的 JSON Schema 子集。 */
type OpenAIParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * 持有一个或多个 MCP 服务器的生命周期。
 * 由 InvoxAgent.newSession / loadSession 创建，session 结束时拆除。
 */
export class McpClientManager {
  private servers = new Map<string, ServerEntry>();
  /** 跨服务器的扁平工具表，按 invoxName 索引。 */
  private tools = new Map<string, McpToolDef>();
  /** 预计算好的 OpenAI 工具规范，覆盖所有发现到的 MCP 工具。 */
  private toolSpecs: ToolSpec[] = [];

  // ---------- 公共 API ----------

  /**
   * 解析配置 → spawn 子进程 → 完成 MCP 握手 → 列出工具。
   * 单个 server 失败仅记日志，不影响其他 server 或会话本身。
   */
  async connect(configs: Record<string, McpServerConfig>): Promise<void> {
    for (const [serverName, cfg] of Object.entries(configs)) {
      if (cfg.type !== "stdio") continue; // 当前仅支持 stdio
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

  /** 返回所有 MCP 工具的 OpenAI tool spec。 */
  getToolSpecs(): ToolSpec[] {
    return this.toolSpecs;
  }

  /** 按 invoxName（mcp__<server>__<tool>）查 MCP 工具元信息。 */
  getMcpTool(name: string): McpToolDef | undefined {
    return this.tools.get(name);
  }

  /**
   * 把一次工具调用转发到对应的 MCP 服务器。
   * 返回原始结果，由 mcp/tool.ts 的 factory 负责包装成 ToolExecResult。
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

  /** 关闭所有 MCP 连接并 kill 子进程。 */
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

  // ---------- 内部 ----------

  /**
   * 把 MCP inputSchema（JSON Schema）转换成 OpenAI ToolSpec 的 `parameters` 形状。
   * 剥掉 MCP 专有字段，确保 type / properties 必在，required 可选。
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
