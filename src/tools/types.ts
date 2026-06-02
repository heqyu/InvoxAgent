// Per-tool contracts shared across the registry.

import type {
  AgentSideConnection,
  ClientCapabilities,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { ToolSpec } from "../llm/types.js";
import type { FileCache } from "./cache.js";

export type PermissionPolicy = "never" | "writes" | "always";

export type RiskTier = "read" | "write" | "execute";

/**
 * Per-session state shared across tool calls within one ACP session.
 *
 * Lives on the agent's Session object and is passed by reference into every
 * tool execution. Tools mutate it (e.g. read_file populates the cache,
 * edit_file invalidates it) so subsequent calls within the same turn see
 * a coherent view.
 */
export interface SessionToolState {
  /** Absolute paths the LLM has read this session — gates edit_file. */
  readPaths: Set<string>;
  /** Per-path content cache (see ./cache.ts for invalidation rules). */
  cache: FileCache;
}

export interface ToolExecContext {
  conn: AgentSideConnection;
  sessionId: string;
  cwd: string;
  caps: ClientCapabilities;
  signal: AbortSignal;
  policy: PermissionPolicy;
  toolCallId: string;
  state: SessionToolState;
}

export interface ToolExecResult {
  /** String result fed back to the LLM as the `tool` message body. */
  resultText: string;
  /** Rich content for the ACP `tool_call_update` notification. */
  acpContent: ToolCallContent[];
  /** ACP `kind` discriminator for the tool_call notification. */
  kind: "read" | "edit" | "execute" | "other";
  /** Human-readable title; shown in the client's UI. */
  title: string;
  /**
   * File locations affected by this tool call. Enables "follow-along" /
   * "Go to File" affordances in clients (Zed renders these as clickable
   * jump targets next to the tool card).
   */
  locations?: ToolCallLocation[];
  /** Whether the call succeeded (drives status: completed | failed | cancelled). */
  ok: boolean;
  /** True iff the user denied the action; the LLM should be told. */
  denied?: boolean;
}

/**
 * The contract every tool implements. The registry collects these and the
 * router dispatches by `name`.
 */
export interface Tool {
  /** Lowercase identifier. Must be unique. Sent to the LLM as function.name. */
  readonly name: string;
  /** Risk tier — drives the permission gate in router.ts. */
  readonly tier: RiskTier;
  /** OpenAI tool spec given to the LLM. The function.name MUST match `name`. */
  readonly spec: ToolSpec;
  /** Run the tool and produce a result the agent can stream back. */
  execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult>;
}

/** Helper used by every tool's error paths. */
export function errorResult(
  msg: string,
  kind: "read" | "edit" | "execute" | "other",
  title: string,
): ToolExecResult {
  return {
    resultText: `ERROR: ${msg}`,
    acpContent: [{ type: "content", content: { type: "text", text: `Error: ${msg}` } }],
    kind,
    title,
    ok: false,
  };
}
