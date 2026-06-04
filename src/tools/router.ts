// Tool router — thin dispatcher: parses args, gates permission, calls the
// tool's execute(). Each tool's actual logic lives in its own file under
// src/tools/.

import { log } from "../log.js";
import { parseToolArguments } from "../agent/json.js";
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

  // A3 / K5：用共享的 parseToolArguments 替代本地 try/catch；它和 agent.ts 走
  // 同一套语义（空字符串 → {}，非对象 → err，畸形 JSON → err with preview）。
  const argsResult = parseToolArguments(rawArgs);
  if (!argsResult.ok) {
    return errorResult(argsResult.error, "other", `${name}(?)`);
  }
  const args = argsResult.value;

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
