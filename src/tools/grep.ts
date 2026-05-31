// grep: full-text search via ripgrep. The @vscode/ripgrep package ships a
// platform-specific binary so we don't need the system `rg` to be installed.
//
// Output mode: line-oriented `path:lineno:content` by default. The LLM can
// ask for files-only (-l) or count-per-file. Context lines (-A/-B/-C) and
// case-insensitive (-i) are exposed.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { errorResult, type Tool, type ToolExecContext, type ToolExecResult } from "./types.js";

const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB output cap

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "grep",
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
        description: DESCRIPTION_FIELD,
      },
      required: ["pattern", "description"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const pattern = String(args["pattern"] ?? "");
  if (!pattern) return errorResult("missing 'pattern'", "other", "grep");

  const rawPath = typeof args["path"] === "string" ? args["path"] : "";
  const searchRoot = rawPath ? resolve(ctx.cwd, rawPath) : ctx.cwd;

  const outputMode = (() => {
    const m = String(args["output_mode"] ?? "content");
    if (m === "files_with_matches" || m === "count" || m === "content") return m;
    return "content";
  })();

  const caseInsensitive = args["case_insensitive"] === true;
  const context =
    typeof args["context"] === "number" && args["context"] >= 0
      ? Math.floor(args["context"])
      : 0;
  const limit =
    typeof args["limit"] === "number" && args["limit"] > 0 ? Math.floor(args["limit"]) : 0;
  const globRestrict = typeof args["glob"] === "string" ? args["glob"] : "";

  const rgArgs: string[] = [];
  if (caseInsensitive) rgArgs.push("-i");
  if (outputMode === "files_with_matches") rgArgs.push("-l");
  else if (outputMode === "count") rgArgs.push("-c");
  else {
    // content mode default
    rgArgs.push("-n", "--no-heading", "--color=never");
    if (context > 0) rgArgs.push(`-C${context}`);
  }
  if (globRestrict) rgArgs.push("-g", globRestrict);
  // Belt-and-suspenders: always ignore these huge dirs even if .gitignore
  // doesn't list them (e.g. dist after fresh clone).
  rgArgs.push("--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist", "--glob", "!build");
  // Use -- to terminate flag parsing so a pattern starting with '-' is safe.
  rgArgs.push("--", pattern, searchRoot);

  log.info("tool: grep", { pattern, searchRoot, outputMode, caseInsensitive, context, limit });

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
          stdout += d.toString("utf8").slice(0, Math.max(0, DEFAULT_MAX_BYTES - (bytes - d.length)));
        }
        // Past the cap: drop the rest. Don't kill the process — let rg
        // finish so we get a clean exit code, but stop accumulating.
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
        // already exited
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      resolveResult(errorResult(`rg spawn failed: ${err.message}`, "other", `grep: ${pattern}`));
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);

      // ripgrep exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (exitCode === 2) {
        resolveResult(
          errorResult(
            `ripgrep error: ${stderr.trim() || "exit 2"}`,
            "other",
            `grep: ${pattern}`,
          ),
        );
        return;
      }

      let display = stdout;
      // Optional line cap on top of the byte cap.
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

      const body = exitCode === 1 ? "(no matches)" : display.trim() || "(no matches)";
      const text = header + body;

      resolveResult({
        resultText: text,
        acpContent: [{ type: "content", content: { type: "text", text } }],
        kind: "other",
        title: titleFor(args, pattern),
        ok: true,
      });
    });
  });
}

function titleFor(args: Record<string, unknown>, pattern: string): string {
  const desc = typeof args["description"] === "string" ? args["description"].trim() : "";
  if (desc) return desc;
  return `Grep ${pattern}`;
}

export const grepTool: Tool = {
  name: "grep",
  tier: "read",
  spec,
  execute,
};
