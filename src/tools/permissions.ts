// Permission gate. Pulled out of the per-tool execute() so each tool stays
// small and the policy is enforced uniformly.

import { log } from "../log.js";
import type { PermissionPolicy, RiskTier, ToolExecContext } from "./types.js";

export function needsPermission(tier: RiskTier, policy: PermissionPolicy): boolean {
  if (policy === "always") return true;
  if (policy === "writes") return tier === "write" || tier === "execute";
  return false;
}

export function kindFromTier(tier: RiskTier): "read" | "edit" | "execute" {
  return tier === "read" ? "read" : tier === "write" ? "edit" : "execute";
}

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
    return false; // cancelled = treat as deny
  } catch (e) {
    log.warn("requestPermission failed; defaulting to deny", String(e));
    return false;
  }
}
