// Hook 命令执行层 —— 从 hooks.ts 拆出，降低单文件复杂度。
//
// 职责：
//   - runHookCommand  —— spawn 单条 shell 命令，读 stdout JSON 响应
//   - runHooks        —— 遍历匹配的 hook group，聚合结果
//   - collectGroups   —— 按 event + toolName 过滤 hook group
//   - eventKey        —— HookEventName → registry 属性名映射

import { spawn } from "node:child_process";
import { createLogger } from "../log.js";
const log = createLogger("plugins");
import type {
  HookCommand,
  HookContext,
  HookEventName,
  HookResponse,
  HookRegistry,
  ResolvedHookGroup,
} from "./hooks.js";
import { matchesTool } from "./hooks.js";

/**
 * 执行单条 hook 命令：context 写入 stdin，从 stdout 解析 JSON 响应。
 * 返回：解析后的 HookResponse + 退出码 + stderr 文本。
 * 命令是 async（fire-and-forget）或失败时 response 为 null。
 */
export function runHookCommand(
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

      // Claude Code 规范：「退出码 2 表示阻塞错误。Claude Code 忽略 stdout，
      // 任何 stdout 中的 JSON 都不解析；改用 stderr 文本作为错误说明。」
      // 所以必须先看 exit code 再决定是否解析 stdout。
      let response: HookResponse | null = null;

      if (code === 2) {
        // 退出码 2 = 阻塞信号，stdout 按规范忽略。stderr 是给人看的原因。
        const errText = stderr.trim();
        response = {
          continue: false,
          reason: errText || `blocked by ${hookEvent} hook`,
          systemMessage: errText || `blocked by ${hookEvent} hook`,
        };
      } else if (stdout.trim()) {
        // 退出码 0 或其他：尝试解析 stdout JSON 作为结构化指令
        try {
          response = JSON.parse(stdout.trim()) as HookResponse;
          // 归一化 Claude Code 约定：decision → continue
          if (
            response &&
            typeof (response as Record<string, unknown>).decision === "string"
          ) {
            const decision = (response as Record<string, unknown>)
              .decision as string;
            if (decision === "block" && response.continue === undefined) {
              response.continue = false;
              // reason 是注入回会话的指令文本，让 agent 知道接下来该做什么
              if (response.reason && response.reason.length > 0) {
                response.systemMessage = response.reason;
              }
            } else if (
              decision === "allow" &&
              response.continue === undefined
            ) {
              response.continue = true;
            }
          }
        } catch {
          // 非 JSON stdout 忽略（debug 输出等）
        }
      }

      log.debug("hook stdout", {
        hookEvent,
        command: cmd.command.substring(0, 120),
        exitCode: code,
        stdout: stdout.trim().substring(0, 500),
        stderr: stderr.trim().substring(0, 200),
        parsedResponse: response,
      });

      resolve({ response, exitCode: code, stderr });
    });

    // 把 context JSON 写到 stdin 并关闭
    log.debug("hook stdin", {
      hookEvent,
      command: cmd.command.substring(0, 120),
      stdin: jsonCtx.trim(),
    });
    child.stdin.write(jsonCtx);
    child.stdin.end();
  });
}

/**
 * 把命令字符串里的 ${CLAUDE_PLUGIN_ROOT} / ${CODEBUDDY_PLUGIN_ROOT}
 * 替换成实际 plugin 根目录。
 */
function resolveEnvInCommand(command: string, pluginRoot: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CODEBUDDY_PLUGIN_ROOT\}/g, pluginRoot);
}

// ── Hook runner（agent.ts 调用入口）─────────────────────────────────

/** 收集事件下的 hook group 并按 toolName 过滤 matcher。 */
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
 * 跑事件下匹配的所有 hook 命令：
 * - async 命令后台 spawn 不等
 * - 同步命令 await 后聚合结果；首个 continue=false 立即停下，返回带 reason 的聚合
 */
export async function runHooks(
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
        // fire-and-forget：spawn 但不 await
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
          if (response.continue === false) {
            agg.continue = false;
            // Claude Code 规范：一旦阻塞，立即停下后续 hook，第一个阻塞胜出
            if (response.reason) agg.reason = response.reason;
            if (response.systemMessage)
              agg.systemMessage = response.systemMessage;
            return agg;
          }
          if (response.systemMessage)
            systemMessages.push(response.systemMessage);
          // 传播 hookSpecificOutput.modifiedInput（PreToolUse 注入环境变量等场景）
          if (response.hookSpecificOutput?.modifiedInput) {
            agg.hookSpecificOutput = {
              ...agg.hookSpecificOutput,
              modifiedInput: response.hookSpecificOutput.modifiedInput,
            };
          }
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
