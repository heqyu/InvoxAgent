// Bash 工具：跑一条 shell 命令并把它呈现给用户。
//
// 两条执行路径：
//
// 1. ACP terminal（客户端能力 `terminal: true` 时优先，例如 Zed）。
//    命令在客户端管理的终端里运行，工具卡片携带 `{ type: "terminal", terminalId }`。
//    Zed 会原生渲染实时命令头（cwd + 彩色命令）和 ANSI 流式输出 ——
//    正是用户期待的"Run Command"卡片。命令结束后我们再 currentOutput()
//    取最终输出回灌给 LLM，让模型看到的形状与平时一致。
//
// 2. 本地 spawn 兜底（客户端不支持 terminal/* 时，例如 smoke 脚本或非 Zed
//    客户端）。最终结果文本两条路径一致。
//
// Windows 下 shell 选择：优先 Git Bash（`bash -lc <cmd>`），其次 cmd.exe。
// 原因：当 Zed 在 Windows 用 ConPTY 托管终端运行 cmd.exe 时，cmd 偶尔会
// 先吐自己的交互 banner（"Microsoft Windows [版本 ...]" + 提示符）然后
// 在 currentOutput() 还没捕获到真正命令输出前就退出，让 LLM 拿到一个
// "看起来是空"的结果，触发"是不是空仓库？"的兔子洞。同 ConPTY 下 Git Bash
// 行为正常。用户可通过 INVOX_SHELL 强制：
//   "bash"        → 找标准 Git Bash
//   "cmd"         → 强制 cmd.exe
//   绝对路径      → 直接用该可执行文件
// 非 Windows 沿用 /bin/sh -c。
//
// Windows 上 ACP terminal/create 历史上若把整段 `cmd /c <command>` 塞进
// `command` 字段，Zed 会重新分词破坏引号。我们绕开的办法是把 shell 放在
// `command`，把用户命令作为 `args` 单元素数组传入 —— 客户端就没机会再切了。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Bash",
    description:
      "Execute a shell command in the session's working directory. " +
      "Pipes / redirects / quoting work the way the OS's default shell " +
      "(cmd on Windows, /bin/sh on POSIX) parses them. Returns combined " +
      "stdout+stderr and the exit code. Use this for build/test/git/grep " +
      "commands; for editing files prefer Edit.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The full command line to run.",
        },
      },
      required: ["command"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const rawCommand = String(args["command"] ?? "");
  if (!rawCommand) return errorResult("missing 'command'", "execute", "Bash");
  log.debug("tool: Bash", { command: rawCommand });

  // 尝试通过 `rtk rewrite` 改写命令；改写成功且非空则用改写后的，否则原样。
  let command = rawCommand;
  try {
    const rewritten = await runRtkRewrite(rawCommand, ctx.cwd);
    if (rewritten) {
      command = rewritten;
      if (command === rawCommand) {
        log.info("Bash: rtk rewrite returned unchanged", {
          command: rawCommand,
        });
      } else {
        log.info("Bash: rtk rewrite succeeded", {
          original: rawCommand,
          rewritten: command,
        });
      }
    }
  } catch (e) {
    log.debug("Bash: rtk rewrite failed, using original command", {
      error: (e as Error).message,
    });
  }

  if (ctx.caps.terminal === true) {
    return runViaAcpTerminal(command, args, ctx);
  }
  return runViaLocalSpawn(command, args, ctx);
}

// ── rtk rewrite ─────────────────────────────────────────────────────

/**
 * 本机 rtk 是否可用的缓存。null = 还没探测；true / false = 探测结果。
 * 只在第一次 Bash 调用时探测，之后所有调用都直接看缓存。
 */
let rtkAvailable: boolean | null = null;

/** 探测 rtk 是否安装；进程内缓存。 */
async function ensureRtkProbed(cwd: string): Promise<boolean> {
  if (rtkAvailable !== null) return rtkAvailable;
  const { shellCmd, shellArgs } = buildShellInvocation("rtk --version");
  rtkAvailable = await new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn(shellCmd, shellArgs, {
      cwd,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0);
      }
    });
  });
  if (!rtkAvailable) {
    log.debug("Bash: rtk not available, rewrite disabled for this session");
  }
  return rtkAvailable;
}

/**
 * 跑 `rtk rewrite '<command>'`，返回改写后的命令字符串；失败返回空串让
 * 调用方回退原始命令。rtk 探测为 absent 时直接跳过 spawn。
 */
async function runRtkRewrite(command: string, cwd: string): Promise<string> {
  if (!(await ensureRtkProbed(cwd))) return "";

  const rewriteCmd = `rtk rewrite '${command.replace(/'/g, "'\\''")}'`;
  const { shellCmd, shellArgs } = buildShellInvocation(rewriteCmd);

  return new Promise<string>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(shellCmd, shellArgs, { cwd, windowsHide: true });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve("");
      }
    });

    child.on("close", (exitCode) => {
      if (!settled) {
        settled = true;
        const trimmed = stdout.trim();
        // exit 0 / 3 = 改写成功（rtk 文档与实测）；exit 1 = 没有 RTK 等价命令
        if (trimmed && exitCode !== 1) {
          resolve(trimmed);
        } else {
          resolve("");
        }
      }
    });
  });
}

// ── ACP terminal 路径（Zed）─────────────────────────────────────────

async function runViaAcpTerminal(
  command: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  // 把 shell 放在 command，把用户命令作为 args 的单元素 —— 绕开 Zed 在
  // Windows 上对 argv 的二次切分。
  const { shellCmd, shellArgs } = buildShellInvocation(command);

  const terminal = await ctx.conn.createTerminal({
    sessionId: ctx.sessionId,
    command: shellCmd,
    args: shellArgs,
    cwd: ctx.cwd,
  });

  const onAbort = (): void => {
    terminal.kill().catch(() => {
      // 终端可能已退出
    });
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const title = titleFor(args, command);

  // **重要**：在 waitForExit() 阻塞之前把嵌入终端立即挂到工具卡片上。
  // Zed 仅在看到 in_progress 状态下的 `{type:"terminal", terminalId}` 时
  // 才会渲染可折叠的终端块。如果等命令退出后再 attach，git log 等快命令
  // 早结束了，Zed 还没来得及挂载终端面板，用户最终只看到一行标题、没有
  // 可展开内容。后续 tool_call_update 会复用同一个 terminalId，所以这是
  // 纯 UX 增益，没有重复渲染问题。
  await ctx.conn
    .sessionUpdate({
      sessionId: ctx.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: ctx.toolCallId,
        status: "in_progress",
        title,
        kind: "execute",
        content: [{ type: "terminal", terminalId: terminal.id }],
      },
    })
    .catch(() => {
      // 客户端拒收 in-flight update 也无所谓，post-exit 还会再发一次同 terminalId
    });

  try {
    const exit = await terminal.waitForExit();
    const out = await terminal.currentOutput();
    const exitCode = exit.exitCode ?? null;
    const signal = exit.signal ?? null;

    const display =
      `$ ${command}\n` +
      `exit=${exitCode ?? "?"}${signal ? ` signal=${signal}` : ""}\n` +
      (out.output.length > 0 ? out.output : "(no output)") +
      (out.truncated ? "\n[output truncated by client]" : "");

    return {
      resultText: display,
      acpContent: [{ type: "terminal", terminalId: terminal.id }],
      kind: "execute",
      title,
      ok: exitCode === 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const display = `$ ${command}\nerror: ${message}\n`;
    return {
      resultText: display,
      acpContent: [{ type: "terminal", terminalId: terminal.id }],
      kind: "execute",
      title,
      ok: false,
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    // ACP 规定：含此 terminalId 的工具卡在 release 后仍会继续显示其输出
    terminal.release().catch(() => {
      // best-effort
    });
  }
}

function buildShellInvocation(command: string): {
  shellCmd: string;
  shellArgs: string[];
} {
  if (process.platform === "win32") {
    const bash = pickWindowsShell();
    if (bash) {
      // -l：login shell，让 /etc/profile + ~/.bashrc 设置 PATH，
      //     这样 git / node 等命令解析与正常 Git Bash 一致。
      // -c：执行字符串后退出。
      return { shellCmd: bash, shellArgs: ["-lc", command] };
    }
    // /d 关闭 AutoRun；/s + 周围引号让命令内引号被保留；/c 执行后退出。
    return { shellCmd: "cmd.exe", shellArgs: ["/d", "/s", "/c", command] };
  }
  return { shellCmd: "/bin/sh", shellArgs: ["-c", command] };
}

/**
 * 解析 Windows 下首选的 shell。进程内缓存，首次使用打日志便于用户在
 * invox.log 里确认。
 *
 * 返回：
 *   - bash.exe 的绝对路径（Git Bash / MSYS / WSL bash 等）
 *   - 或 null，表示回退 cmd.exe
 *
 * 优先级：INVOX_SHELL 环境变量
 *   - "cmd"            → 强制 cmd.exe（返回 null）
 *   - "bash"           → 走标准 Git Bash 候选目录
 *   - 任何绝对路径      → 文件存在则原样使用
 */
let cachedWindowsShell: { value: string | null } | undefined;
function pickWindowsShell(): string | null {
  if (cachedWindowsShell) return cachedWindowsShell.value;

  const override = (process.env["INVOX_SHELL"] ?? "").trim();
  let chosen: string | null;
  if (override.toLowerCase() === "cmd") {
    chosen = null;
  } else if (
    override &&
    override.toLowerCase() !== "bash" &&
    isAbsolute(override)
  ) {
    chosen = existsSync(override) ? override : null;
  } else {
    chosen = findGitBash();
  }

  cachedWindowsShell = { value: chosen };
  log.info("Bash: shell selected", {
    shell: chosen ?? "cmd.exe",
    override: override || undefined,
  });
  return chosen;
}

/**
 * 在已知的 Git Bash 安装位置里挑一个存在的。
 * 故意不仅靠 PATH —— Zed 用 ACP spawn 子进程时继承的 PATH 经常被精简，
 * 不一定包含 Git\bin。
 */
function findGitBash(): string | null {
  const candidates: string[] = [];
  const env = process.env;
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env["LOCALAPPDATA"] ?? "";
  const userProfile = env["USERPROFILE"] ?? "";

  candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  if (localAppData) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  }
  if (userProfile) {
    // scoop / 便携安装常见布局
    candidates.push(`${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
    candidates.push(
      `${userProfile}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`,
    );
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── 本地 spawn 兜底（非 ACP terminal 客户端）─────────────────────────

async function runViaLocalSpawn(
  command: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  return new Promise<ToolExecResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    // 与 ACP terminal 路径用同一套 shell 选择，保证跨 transport 行为一致。
    // 不能用 `shell: true` —— Windows 上它永远 cmd.exe，会失去 pickWindowsShell()。
    const { shellCmd, shellArgs } = buildShellInvocation(command);
    const child = spawn(shellCmd, shellArgs, {
      cwd: ctx.cwd,
      windowsHide: true,
    });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // 进程可能已退出
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      const display = `$ ${command}\nerror: ${err.message}\n`;
      resolveResult({
        resultText: display,
        acpContent: [
          { type: "content", content: { type: "text", text: display } },
        ],
        kind: "execute",
        title: titleFor(args, command),
        ok: false,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);

      const combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const display =
        `$ ${command}\n` +
        `exit=${exitCode ?? "?"}${signal ? ` signal=${signal}` : ""}\n` +
        (combined.length > 0 ? combined : "(no output)");

      resolveResult({
        resultText: display,
        acpContent: [
          { type: "content", content: { type: "text", text: display } },
        ],
        kind: "execute",
        title: titleFor(args, command),
        ok: exitCode === 0,
      });
    });
  });
}

// ── 标题兜底（仅当 agent.ts 没能算出标题时使用）──────────────────────

function titleFor(_args: Record<string, unknown>, command: string): string {
  // 命令优先 —— 与 agent.ts:startTitleFor("bash") 对齐。LLM 自由文案的
  // description 故意不用：它会盖住用户在 in_progress 卡上已经看到的命令，
  // 把 `git log -1 --stat` 之类换成翻译过的中文短语，破坏复制粘贴体验。
  return `\`${command.slice(0, 80)}${command.length > 80 ? "…" : ""}\``;
}

export const bashTool: Tool = {
  name: "Bash",
  tier: "execute",
  spec,
  execute,
};
