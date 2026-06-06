// Grep 工具：用 ripgrep 做全文搜索。
// @vscode/ripgrep 自带平台特定二进制，无需用户系统装 rg。
//
// 输出模式：默认 line-oriented `path:lineno:content`；
// LLM 可指定 files-only (-l) 或 count-per-file (-c)。
// 支持上下文行 (-C)、忽略大小写 (-i)。

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { createLogger } from "../log.js";
const log = createLogger("tools");
import type { ToolSpec } from "../llm/types.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const DEFAULT_MAX_BYTES = 256 * 1024; // 输出字节硬上限：256 KiB

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "Grep",
    description:
      "Search file contents with ripgrep. Returns matches as " +
      "<path>:<line>:<text>. Use this to find symbols, references, or " +
      "any pattern in the project — much faster than running grep via " +
      "bash. Honors .gitignore by default and skips node_modules/.git/dist/build. " +
      "Set output_mode='files_with_matches' for just file paths, " +
      "or output_mode='count' for one count-per-file.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regex pattern. ripgrep uses Rust regex syntax (similar to PCRE). " +
            "Use \\\\b for word boundaries, etc.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search. Optional; defaults to session cwd.",
        },
        glob: {
          type: "string",
          description:
            "Restrict to files matching this glob, e.g. '*.ts' or '*.{ts,tsx}'. " +
            "Optional.",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            "Output format. 'content' (default) shows matching lines; " +
            "'files_with_matches' lists unique file paths; " +
            "'count' gives match-count-per-file.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Case-insensitive search. Default false.",
        },
        context: {
          type: "integer",
          description:
            "Number of context lines to include before AND after each match " +
            "(rg -C). Only honored in content mode.",
        },
        limit: {
          type: "integer",
          description:
            "Max output lines (after which we truncate). Default unlimited up " +
            "to a 256 KiB byte cap.",
        },
      },
      required: ["pattern"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const pattern = String(args["pattern"] ?? "");
  if (!pattern) return errorResult("missing 'pattern'", "other", "Grep");

  const rawPath = typeof args["path"] === "string" ? args["path"] : "";
  const searchRoot = rawPath ? resolve(ctx.cwd, rawPath) : ctx.cwd;

  const outputMode = (() => {
    const m = String(args["output_mode"] ?? "content");
    if (m === "files_with_matches" || m === "count" || m === "content")
      return m;
    return "content";
  })();

  const caseInsensitive = args["case_insensitive"] === true;
  const context =
    typeof args["context"] === "number" && args["context"] >= 0
      ? Math.floor(args["context"])
      : 0;
  const limit =
    typeof args["limit"] === "number" && args["limit"] > 0
      ? Math.floor(args["limit"])
      : 0;
  const globRestrict = typeof args["glob"] === "string" ? args["glob"] : "";

  const rgArgs: string[] = [];
  if (caseInsensitive) rgArgs.push("-i");
  if (outputMode === "files_with_matches") rgArgs.push("-l");
  else if (outputMode === "count") rgArgs.push("-c");
  else {
    // content 模式默认开启行号、不分组、关闭 ANSI 颜色
    rgArgs.push("-n", "--no-heading", "--color=never");
    if (context > 0) rgArgs.push(`-C${context}`);
  }
  if (globRestrict) rgArgs.push("-g", globRestrict);
  // belt-and-suspenders：即使 .gitignore 漏列也兜底屏蔽这几个大目录
  rgArgs.push(
    "--glob",
    "!node_modules",
    "--glob",
    "!.git",
    "--glob",
    "!dist",
    "--glob",
    "!build",
  );
  // 用 -- 终止参数解析，让以 '-' 开头的 pattern 也安全
  rgArgs.push("--", pattern, searchRoot);

  log.debug("tool: Grep", {
    pattern,
    searchRoot,
    outputMode,
    caseInsensitive,
    context,
    limit,
  });

  return new Promise<ToolExecResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let settled = false;

    const child = spawn(rgPath, rgArgs, {
      cwd: ctx.cwd,
      windowsHide: true,
    });

    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > DEFAULT_MAX_BYTES) {
        if (!truncated) {
          truncated = true;
          stdout += d
            .toString("utf8")
            .slice(0, Math.max(0, DEFAULT_MAX_BYTES - (bytes - d.length)));
        }
        // 超过上限后丢弃；不杀 rg —— 让它自然退出，我们仍能拿到干净的 exit code
      } else {
        stdout += d.toString("utf8");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // 已退出
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      resolveResult(
        errorResult(
          `rg spawn failed: ${err.message}`,
          "other",
          `Grep: ${pattern}`,
        ),
      );
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);

      // ripgrep 退出码：0 = 有匹配，1 = 无匹配，2 = 错误
      if (exitCode === 2) {
        resolveResult(
          errorResult(
            `ripgrep error: ${stderr.trim() || "exit 2"}`,
            "other",
            `Grep: ${pattern}`,
          ),
        );
        return;
      }

      let display = stdout;
      // 字节上限之上再叠加可选行数上限
      if (limit > 0) {
        const lines = display.split("\n");
        if (lines.length > limit) {
          display = lines.slice(0, limit).join("\n");
          truncated = true;
        }
      }
      if (truncated) {
        display += `\n\n[output truncated]\n`;
      }
      const header =
        `Pattern: ${pattern}` +
        (rawPath ? `\nPath: ${searchRoot}` : "") +
        (globRestrict ? `\nGlob: ${globRestrict}` : "") +
        `\nMode: ${outputMode}${caseInsensitive ? " (case-insensitive)" : ""}` +
        (context ? `, context=${context}` : "") +
        `\n`;

      const body =
        exitCode === 1 ? "(no matches)" : display.trim() || "(no matches)";
      const text = header + body;

      resolveResult({
        resultText: text,
        acpContent: [{ type: "content", content: { type: "text", text } }],
        kind: "other",
        title: titleFor(pattern),
        ok: true,
      });
    });
  });
}

function titleFor(pattern: string): string {
  return `Grep ${pattern}`;
}

export const grepTool: Tool = {
  name: "Grep",
  tier: "read",
  spec,
  execute,
};
