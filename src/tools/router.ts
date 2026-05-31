// Tool router — thin dispatcher: parses args, gates permission, calls the
// tool's execute(). Each tool's actual logic lives in its own file under
// src/tools/.

import { log } from "../log.js";
import { kindFromTier, needsPermission, requestPermission } from "./permissions.js";
import { getTool } from "./registry.js";
import { errorResult, type ToolExecContext, type ToolExecResult } from "./types.js";

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const tool = getTool(name);
  if (!tool) {
    return errorResult(`unknown tool: ${name}`, "other", name);
  }

  let args: Record<string, unknown>;
  try {
    args = rawArgs.trim() === "" ? {} : (JSON.parse(rawArgs) as Record<string, unknown>);
  } catch (e) {
    return errorResult(`bad arguments JSON: ${(e as Error).message}`, "other", `${name}(?)`);
  }

  if (needsPermission(tool.tier, ctx.policy)) {
    const granted = await requestPermission(tool.name, tool.tier, args, ctx);
    if (!granted) {
      log.info("permission denied", { name });
      return {
        resultText: `User denied permission for ${name}.`,
        acpContent: [
          { type: "content", content: { type: "text", text: `Permission denied for ${name}.` } },
        ],
        kind: kindFromTier(tool.tier),
        title: `${name} (denied)`,
        ok: false,
        denied: true,
      };
    }
  }

  return tool.execute(args, ctx);
}
