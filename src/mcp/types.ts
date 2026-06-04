// MCP 子系统共享类型。

/** `.claude/.mcp.json` 中 mcpServers 的单条配置。 */
export interface McpServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** `.claude/.mcp.json` 的根结构。 */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** 单个 MCP 工具的元信息 —— 包含原始服务器名 + 对外暴露的 invox 名。 */
export interface McpToolDef {
  /** `.claude/.mcp.json` 中的 server key（如 "codegraph"）。 */
  serverName: string;
  /** MCP 服务器自己上报的工具名（如 "codegraph_search"）。 */
  toolName: string;
  /** invox 内部命名：mcp__<server>__<tool>，作为 LLM 看到的 function.name。 */
  invoxName: string;
  /** 工具描述；部分服务器不上报，可能为空。 */
  description?: string;
  /**
   * 工具参数的 JSON Schema。已被 sanitise（去除 $schema / $defs 等无关字段），
   * 顶层一定带 `type: "object"`。
   */
  inputSchema: Record<string, unknown>;
}
