// MCP tool factory —— 把一个 MCP 工具包装成符合 invox `Tool` 契约的实例。

import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "../tools/types.js";
import type { McpClientManager } from "./client.js";
import type { McpToolDef } from "./types.js";

/** ToolSpec.function.parameters 的形状。 */
type OpenAIParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * 将 MCP `inputSchema` 透传成给 LLM 的 OpenAI `ToolSpec`。
 * MCP 服务器自己定义的 input schema 即真理 —— invox 不再向其中注入额外的
 * 控制字段（`description` 等），避免污染服务器声明的参数列表。
 */
function inputSchemaToToolSpec(def: McpToolDef): ToolSpec {
  const it = def.inputSchema.type;
  const schemaType =
    typeof it === "string" && it === "object" ? "object" : "object";

  const props: Record<string, unknown> =
    def.inputSchema.properties &&
    typeof def.inputSchema.properties === "object" &&
    !Array.isArray(def.inputSchema.properties)
      ? { ...(def.inputSchema.properties as Record<string, unknown>) }
      : {};

  const required = Array.isArray(def.inputSchema.required)
    ? [...def.inputSchema.required]
    : undefined;

  const parameters: OpenAIParameters = {
    type: schemaType,
    properties: props,
    ...(required ? { required } : {}),
  };

  return {
    type: "function",
    function: {
      name: def.invoxName,
      description:
        def.description ?? `MCP tool: ${def.serverName}/${def.toolName}`,
      parameters,
    },
  };
}

/** 创建一个把调用转发到指定 MCP 服务器的 invox `Tool`。 */
export function createMcpTool(
  def: McpToolDef,
  manager: McpClientManager,
): Tool {
  return {
    name: def.invoxName,
    tier: "execute",
    spec: inputSchemaToToolSpec(def),

    async execute(
      args: Record<string, unknown>,
      _ctx: ToolExecContext,
    ): Promise<ToolExecResult> {
      try {
        const result = await manager.callTool(
          def.serverName,
          def.toolName,
          args,
        );

        // 尽力从 MCP content blocks 抽出文本。
        const parts: string[] = [];
        for (const block of result.content) {
          if (block.type === "text") {
            parts.push(block.text);
          }
        }

        const resultText =
          parts.length > 0 ? parts.join("\n") : JSON.stringify(result.content);

        return {
          resultText,
          acpContent: [
            { type: "content", content: { type: "text", text: resultText } },
          ],
          kind: "execute",
          title: `${def.invoxName}`,
          ok: !result.isError,
        };
      } catch (e) {
        return errorResult(
          `MCP tool ${def.invoxName} failed: ${(e as Error).message}`,
          "execute",
          def.invoxName,
        );
      }
    },
  };
}
