// 工具调度器 —— 走权限闸门 → 调用工具 execute()。
// 工具自身的逻辑都在各自文件里，这里只负责派发。
// 参数解析（JSON → Record）由调用方 prompt-loop.ts 统一完成（J3.1）。

import { createLogger } from "../log.js";
const log = createLogger("tools");
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
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const tool = getTool(name);
  if (!tool) {
    return errorResult(`unknown tool: ${name}`, "other", name);
  }

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
