// 权限闸门：从工具 execute() 中抽出来的统一策略点，让每个工具保持精简。

import { log } from "../log.js";
import type { PermissionPolicy, RiskTier, ToolExecContext } from "./types.js";

/** 当前策略下，给定风险等级是否需要走 ACP 权限请求。 */
export function needsPermission(tier: RiskTier, policy: PermissionPolicy): boolean {
  if (policy === "always") return true;
  if (policy === "writes") return tier === "write" || tier === "execute";
  return false;
}

/** 风险等级 → ACP tool_call 的 kind 字段。 */
export function kindFromTier(tier: RiskTier): "read" | "edit" | "execute" {
  return tier === "read" ? "read" : tier === "write" ? "edit" : "execute";
}

/** 通过 ACP `session/request_permission` 询问用户。失败 / 取消都视为 deny。 */
export async function requestPermission(
  toolName: string,
  tier: RiskTier,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<boolean> {
  try {
    const res = await ctx.conn.requestPermission({
      sessionId: ctx.sessionId,
      toolCall: {
        toolCallId: ctx.toolCallId,
        title: `${toolName}(${JSON.stringify(args).slice(0, 80)})`,
        kind: kindFromTier(tier),
        rawInput: args,
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome === "selected") return res.outcome.optionId === "allow";
    return false;
  } catch (e) {
    log.warn("requestPermission failed; defaulting to deny", String(e));
    return false;
  }
}
