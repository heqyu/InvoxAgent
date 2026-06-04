// MCP tool factory —— 把一个 MCP 工具包装成符合 invox `Tool` 契约的实例。

import type { ToolSpec } from "../llm/types.js";
import { DESCRIPTION_FIELD } from "../tools/shared.js";
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
 * 将 MCP `inputSchema` 转换成给 LLM 的 OpenAI `ToolSpec`，并补上 invox 共享的
 * `description` 字段（每个 invox 工具都有，用作工具卡标题）。
 */
function inputSchemaToToolSpec(def: McpToolDef): ToolSpec {
  const it = def.inputSchema.type;
  const schemaType =
    typeof it === "string" && it === "object" ? "object" : "object";

  let props: Record<string, unknown>;
  if (
    def.inputSchema.properties &&
    typeof def.inputSchema.properties === "object" &&
    !Array.isArray(def.inputSchema.properties)
  ) {
    // 合并共享 description 字段 —— LLM 给一段用户可见的卡片标题，
    // 与其他 invox 工具的写法保持一致。
    props = {
      ...(def.inputSchema.properties as Record<string, unknown>),
      ...DESCRIPTION_FIELD,
    };
  } else {
    props = { ...DESCRIPTION_FIELD };
  }

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
      // 转发前剥掉 description —— 它是 invox 内部字段，不属于 MCP 工具的真实输入。
      const mcpArgs = { ...args };
      delete mcpArgs.description;

      try {
        const result = await manager.callTool(
          def.serverName,
          def.toolName,
          mcpArgs,
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
