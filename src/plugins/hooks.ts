// Plugin hook system — lifecycle events that plugins subscribe to via
// shell commands. Modeled after the Claude Code / CodeBuddy hook protocol.
//
// Hook points:
//   SessionStart          — after a new session is created
//   UserPromptSubmit      — when the user submits a prompt
//   PreToolUse            — before a tool executes
//   PostToolUse           — after a tool succeeds
//   PostToolUseFailure      — after a tool fails
//   Stop                  — when the agentic loop ends
//
// Configuration file: <pluginRoot>/hooks/hooks.json
//   {
//     "hooks": {
//       "SessionStart": [
//         {
//           "hooks": [
//             { "type": "command", "command": "bash script.sh", "timeout": 5, "async": false }
//           ]
//         }
//       ],
//       "PreToolUse": [
//         {
//           "matcher": "Write|Edit",
//           "hooks": [ ... ]
//         }
//       ]
//     }
//   }
//
// Each hook command receives context as JSON on stdin and returns a
// JSON response on stdout:
//   { "continue": true, "systemMessage": "..." }
// Exit code 2 means "block the operation" (deny tool / prevent stop).
// async: true commands are fire-and-forget (result is ignored).
// matcher: regex filter for tool name (PreToolUse / PostToolUse only).

import { spawn } from "node:child_process";
import { log } from "../log.js";
import { loadConfigs } from "./loader.js";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ── Hook configuration types ───────────────────────────────────────

export interface HookCommand {
  type: "command";
  command: string;
  /** Timeout in seconds. Default: no limit. */
  timeout?: number;
  /** If true, fire-and-forget — process result is ignored. */
  async?: boolean;
}

export interface HookGroup {
  /** Regex pattern to filter by tool name (PreToolUse / PostToolUse only). */
  matcher?: string;
  description?: string;
  hooks: HookCommand[];
}

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

// ── Hook context types (stdin JSON passed to hook commands) ────────

export interface HookContextBase {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

export interface SessionStartCtx extends HookContextBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume";
}

export interface UserPromptSubmitCtx extends HookContextBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseCtx extends HookContextBase {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseCtx extends HookContextBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

export interface PostToolUseFailureCtx extends HookContextBase {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

export interface StopCtx extends HookContextBase {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
}

export type HookContext =
  | SessionStartCtx
  | UserPromptSubmitCtx
  | PreToolUseCtx
  | PostToolUseCtx
  | PostToolUseFailureCtx
  | StopCtx;

// ── Hook response (parsed from stdout JSON) ────────────────────────

export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  systemMessage?: string;
}

// ── Resolved hook (a hook group with its owning plugin) ─────────────

export interface ResolvedHookGroup {
  pluginRoot: string;
  pluginName: string;
  description?: string;
  matcher?: string;
  hooks: HookCommand[];
}

// ── HookRegistry ────────────────────────────────────────────────────

export class HookRegistry {
  sessionStart: ResolvedHookGroup[] = [];
  userPromptSubmit: ResolvedHookGroup[] = [];
  preToolUse: ResolvedHookGroup[] = [];
  postToolUse: ResolvedHookGroup[] = [];
  postToolUseFailure: ResolvedHookGroup[] = [];
  stop: ResolvedHookGroup[] = [];
}

// ── Cache ───────────────────────────────────────────────────────────

const hookCache = new Map<string, HookRegistry>();

/**
 * Load hooks from all enabled plugins for the given cwd.
 */
export function loadHooks(cwd: string): HookRegistry {
  const cached = hookCache.get(cwd);
  if (cached) return cached;

  const registry = new HookRegistry();
  const configs = loadConfigs(cwd);

  for (const cfg of configs) {
    if (cfg.enabled === false) continue;
    loadHooksFromPlugin(cfg.path, registry);
  }

  hookCache.set(cwd, registry);
  return registry;
}

export function clearHookCache(cwd?: string): void {
  if (cwd) hookCache.delete(cwd);
  else hookCache.clear();
}

// ── Plugin hook loading ─────────────────────────────────────────────

function loadHooksFromPlugin(pluginRoot: string, registry: HookRegistry): void {
  const hooksJsonPath = join(pluginRoot, "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch (e) {
    log.warn("plugins: failed to parse hooks.json", {
      path: hooksJsonPath,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  if (!raw || typeof raw !== "object") return;
  const config = raw as Record<string, unknown>;
  const hooks = config["hooks"];
  if (!hooks || typeof hooks !== "object") return;

  const pluginName = loadPluginName(pluginRoot);

  // Map event names to registry arrays
  const registryMap: Record<string, ResolvedHookGroup[]> = {
    SessionStart: registry.sessionStart,
    UserPromptSubmit: registry.userPromptSubmit,
    PreToolUse: registry.preToolUse,
    PostToolUse: registry.postToolUse,
    PostToolUseFailure: registry.postToolUseFailure,
    Stop: registry.stop,
  };

  for (const [eventName, groups] of Object.entries(
    hooks as Record<string, unknown>,
  )) {
    const target = registryMap[eventName];
    if (!target) {
      log.warn("plugins: unknown hook event in hooks.json", {
        eventName,
        path: hooksJsonPath,
      });
      continue;
    }

    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const hookCommands = g["hooks"];
      if (!Array.isArray(hookCommands)) continue;

      const commands: HookCommand[] = [];
      for (const h of hookCommands) {
        if (!h || typeof h !== "object") continue;
        const cmd = h as Record<string, unknown>;
        if (cmd["type"] !== "command") continue;
        if (typeof cmd["command"] !== "string" || !cmd["command"]) continue;
        commands.push({
          type: "command",
          command: cmd["command"] as string,
          timeout:
            typeof cmd["timeout"] === "number" ? cmd["timeout"] : undefined,
          async: cmd["async"] === true,
        });
      }

      if (commands.length === 0) continue;

      target.push({
        pluginRoot,
        pluginName,
        description:
          typeof g["description"] === "string" ? g["description"] : undefined,
        matcher: typeof g["matcher"] === "string" ? g["matcher"] : undefined,
        hooks: commands,
      });
    }
  }
}

function loadPluginName(pluginRoot: string): string {
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (raw && typeof raw === "object" && "name" in raw) {
      return String(raw["name"]);
    }
  } catch {
    // Fall through
  }
  // Fallback: derive from directory name
  const sep = pluginRoot.includes("\\") ? "\\" : "/";
  const parts = pluginRoot.replace(/[\\/]+$/, "").split(sep);
  return parts[parts.length - 1] ?? pluginRoot;
}

// ── Matcher helper ──────────────────────────────────────────────────

function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true; // No matcher = match all
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // Invalid regex — treat as literal string match
    return matcher === toolName;
  }
}

// ── Command execution ───────────────────────────────────────────────

/**
 * Run a single hook command. Pass context as JSON on stdin, parse
 * JSON response from stdout.
 *
 * Returns parsed HookResponse, or null if the command was async or failed.
 */
function runHookCommand(
  cmd: HookCommand,
  jsonCtx: string,
  pluginRoot: string,
  hookEvent: string,
  timeoutMs?: number,
): Promise<{
  response: HookResponse | null;
  exitCode: number | null;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, {
      shell: true,
      cwd: pluginRoot,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CODEBUDDY_PLUGIN_ROOT: pluginRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (!resolved) {
            resolved = true;
            child.kill();
            log.warn("plugins: hook command timed out", {
              command: cmd.command.substring(0, 120),
              hookEvent,
              timeoutMs,
            });
            resolve({ response: null, exitCode: null, stderr: "timeout" });
          }
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        log.warn("plugins: hook command spawn failed", {
          command: cmd.command.substring(0, 120),
          hookEvent,
          error: err.message,
        });
        resolve({ response: null, exitCode: null, stderr: err.message });
      }
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);

      // Parse stdout JSON response
      let response: HookResponse | null = null;
      if (stdout.trim()) {
        try {
          response = JSON.parse(stdout.trim()) as HookResponse;
        } catch {
          // Non-JSON stdout is ignored (e.g. debug output)
        }
      }

      // Exit code 2 = block signal (deny tool, prevent stop, etc.)
      if (code === 2 && stderr.trim()) {
        response = {
          continue: false,
          systemMessage: `[blocked by ${hookEvent} hook] ${stderr.trim()}`,
        };
      }

      resolve({ response, exitCode: code, stderr });
    });

    // Write context JSON to stdin and close
    child.stdin.write(jsonCtx);
    child.stdin.end();
  });
}

/**
 * Resolve environment variable references in a command string.
 * Replaces ${CLAUDE_PLUGIN_ROOT} and ${CODEBUDDY_PLUGIN_ROOT} with
 * the actual plugin root path.
 */
function resolveEnvInCommand(command: string, pluginRoot: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CODEBUDDY_PLUGIN_ROOT\}/g, pluginRoot);
}

// ── Hook runners (called from agent.ts) ─────────────────────────────

/**
 * Collect all hook groups for a given event, filtering by matcher (tool name).
 */
function collectGroups(
  registry: HookRegistry | undefined,
  event: HookEventName,
  toolName?: string,
): ResolvedHookGroup[] {
  if (!registry) return [];

  const groups: ResolvedHookGroup[] =
    (registry as Record<string, any>)[eventKey(event)] ?? [];

  if (!toolName) return groups;

  return groups.filter((g) => matchesTool(g.matcher, toolName));
}

function eventKey(event: HookEventName): string {
  switch (event) {
    case "SessionStart":
      return "sessionStart";
    case "UserPromptSubmit":
      return "userPromptSubmit";
    case "PreToolUse":
      return "preToolUse";
    case "PostToolUse":
      return "postToolUse";
    case "PostToolUseFailure":
      return "postToolUseFailure";
    case "Stop":
      return "stop";
  }
}

/**
 * Run all hook commands across all matching groups.
 *
 * - async commands: spawned in background (fire-and-forget)
 * - non-async commands: awaited, results aggregated
 *
 * Returns aggregated HookResponse.
 */
async function runHooks(
  registry: HookRegistry | undefined,
  ctx: HookContext,
  toolName?: string,
): Promise<HookResponse> {
  const groups = collectGroups(registry, ctx.hook_event_name, toolName);
  if (groups.length === 0) return { continue: true };

  const jsonCtx = JSON.stringify(ctx) + "\n";
  const agg: HookResponse = { continue: true };
  const systemMessages: string[] = [];

  for (const group of groups) {
    for (const cmd of group.hooks) {
      const resolvedCmd = resolveEnvInCommand(cmd.command, group.pluginRoot);
      const timeoutMs = cmd.timeout ? cmd.timeout * 1000 : undefined;

      if (cmd.async) {
        // Fire-and-forget: spawn but don't await
        runHookCommand(
          { ...cmd, command: resolvedCmd },
          jsonCtx,
          group.pluginRoot,
          ctx.hook_event_name,
          timeoutMs,
        ).catch(() => {});
        continue;
      }

      try {
        const { response } = await runHookCommand(
          { ...cmd, command: resolvedCmd },
          jsonCtx,
          group.pluginRoot,
          ctx.hook_event_name,
          timeoutMs,
        );

        if (response) {
          if (response.continue === false) agg.continue = false;
          if (response.systemMessage)
            systemMessages.push(response.systemMessage);
        }
      } catch (e) {
        log.warn("plugins: hook command failed", {
          hookEvent: ctx.hook_event_name,
          command: resolvedCmd.substring(0, 120),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (systemMessages.length > 0) {
    agg.systemMessage = systemMessages.join("\n\n");
  }
  agg.suppressOutput = systemMessages.length === 0;

  return agg;
}

// ── Public hook runner functions ────────────────────────────────────

export async function runSessionStart(
  registry: HookRegistry | undefined,
  ctx: SessionStartCtx,
): Promise<void> {
  if (!registry?.sessionStart.length) return;
  // SessionStart hooks are fire-and-forget — don't block session creation.
  await runHooks(registry, ctx).catch(() => {});
}

export async function runUserPromptSubmit(
  registry: HookRegistry | undefined,
  ctx: UserPromptSubmitCtx,
): Promise<{ continue: boolean; systemMessage?: string }> {
  const result = await runHooks(registry, ctx);
  return {
    continue: result.continue !== false,
    systemMessage: result.systemMessage,
  };
}

export async function runPreToolUse(
  registry: HookRegistry | undefined,
  ctx: PreToolUseCtx,
): Promise<{ allow: boolean; reason?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  if (result.continue === false) {
    return { allow: false, reason: result.systemMessage ?? "blocked by hook" };
  }
  return { allow: true };
}

export async function runPostToolUse(
  registry: HookRegistry | undefined,
  ctx: PostToolUseCtx,
): Promise<{ systemMessage?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  return { systemMessage: result.systemMessage };
}

export async function runPostToolUseFailure(
  registry: HookRegistry | undefined,
  ctx: PostToolUseFailureCtx,
): Promise<{ systemMessage?: string }> {
  const result = await runHooks(registry, ctx, ctx.tool_name);
  return { systemMessage: result.systemMessage };
}

export async function runStop(
  registry: HookRegistry | undefined,
  ctx: StopCtx,
): Promise<boolean> {
  const result = await runHooks(registry, ctx);
  // Default: stop. If a hook sets continue=true, the agent continues.
  // If a hook blocks (continue=false), the agent stops.
  return result.continue !== false; // false = should stop
}
