// 工具调度器 —— 解析参数 → 走权限闸门 → 调用工具 execute()。
// 工具自身的逻辑都在各自文件里，这里只负责派发。

import { createLogger } from "../log.js";
const log = createLogger("tools");
import { parseToolArguments } from "../agent/json.js";
import {
  kindFromTier,
  needsPermission,
  requestPermission,
} from "./permissions.js";
import { getTool } from "./registry.js";
import {
  errorResult,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const tool = getTool(name);
  if (!tool) {
    return errorResult(`unknown tool: ${name}`, "other", name);
  }

  // 与 agent.ts 共用同一套语义：空字符串 → {}，非对象 → err，畸形 JSON → err（带预览）。
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
          {
            type: "content",
            content: { type: "text", text: `Permission denied for ${name}.` },
          },
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
