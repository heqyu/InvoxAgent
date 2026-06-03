// MCP tool factory — wraps an MCP tool as an invox Tool instance.

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

/** Shape of ToolSpec.function.parameters. */
type OpenAIParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * Convert an MCP `inputSchema` to the OpenAI `ToolSpec` the invox agent
 * sends to the LLM. The only addition is the shared `description` field
 * that every invox tool carries.
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
    // Merge in the shared description param (the LLM provides a
    // user-facing label for tool cards, same as every other invox tool).
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

/** Create an invox `Tool` that forwards to an MCP server. */
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
      // Strip the shared description before forwarding to MCP — it's an
      // invox-internal field, not part of the tool's actual input schema.
      const mcpArgs = { ...args };
      delete mcpArgs.description;

      try {
        const result = await manager.callTool(
          def.serverName,
          def.toolName,
          mcpArgs,
        );

        // Best-effort text extraction from MCP content blocks.
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
