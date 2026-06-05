// MakePlan 工具：把 Plan Agent 的规划结果落盘到 <cwd>/.invox/plans/<theme>.md。

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { log } from "../log.js";
import type { ToolSpec } from "../llm/types.js";
import { isInsideWorkspace, readFileDirect } from "./fs-utils.js";
import {
  errorResult,
  type Tool,
  type ToolExecContext,
  type ToolExecResult,
} from "./types.js";

const spec: ToolSpec = {
  type: "function",
  function: {
    name: "MakePlan",
    description:
      "Persist a Markdown plan into <cwd>/.invox/plans/<theme>.md. " +
      "Use this in Plan mode after investigation to save the final written plan. " +
      "The theme must be a file stem, not a path.",
    parameters: {
      type: "object",
      properties: {
        theme: {
          type: "string",
          description:
            "Plan theme used as the file name stem. The output path is always <cwd>/.invox/plans/<theme>.md.",
        },
        content: {
          type: "string",
          description: "Full Markdown content of the plan.",
        },
      },
      required: ["theme", "content"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  const themeResult = normalizeTheme(args["theme"]);
  if (!themeResult.ok) return errorResult(themeResult.error, "edit", "MakePlan");

  if (typeof args["content"] !== "string") {
    return errorResult("missing 'content'", "edit", "MakePlan");
  }
  const content = args["content"];
  if (!content.trim()) return errorResult("missing 'content'", "edit", "MakePlan");

  const theme = themeResult.theme;

  const path = resolve(ctx.cwd, ".invox", "plans", `${theme}.md`);
  const plansDir = resolve(ctx.cwd, ".invox", "plans");
  const rel = `.invox/plans/${theme}.md`;

  if (!isInsideWorkspace(path, plansDir)) {
    return errorResult(
      "theme must resolve inside .invox/plans",
      "edit",
      `MakePlan: ${theme}`,
    );
  }
  if (!isInsideWorkspace(path, ctx.cwd)) {
    return errorResult(
      "target path must stay inside workspace",
      "edit",
      `MakePlan: ${theme}`,
    );
  }
  if (!ctx.caps.fs?.writeTextFile) {
    log.debug("MakePlan: ACP fs.writeTextFile capability missing", { path });
    return errorResult(
      "client does not advertise fs.writeTextFile capability",
      "edit",
      `MakePlan: ${theme}`,
    );
  }

  let oldText: string | null = null;
  const cached = ctx.state.cache.get(path);
  if (cached) {
    oldText = cached.content;
  } else {
    try {
      if (ctx.caps.fs?.readTextFile) {
        const r = await ctx.conn.readTextFile({ sessionId: ctx.sessionId, path });
        oldText = r.content;
      } else {
        oldText = await readFileDirect(path);
      }
    } catch {
      oldText = null;
    }
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path, content });
  } catch (e) {
    log.debug("MakePlan: write FAILED", {
      path,
      error: (e as Error).message,
    });
    return errorResult(
      `write failed: ${(e as Error).message}`,
      "edit",
      `MakePlan: ${theme}`,
    );
  }

  ctx.state.cache.set(path, content);
  ctx.state.readPaths.add(path);
  log.debug("MakePlan: completed", { path, bytes: content.length });

  return {
    resultText: `saved plan to ${rel} (${content.length} bytes)`,
    acpContent: [
      {
        type: "diff",
        path,
        oldText,
        newText: content,
      },
    ],
    kind: "edit",
    title: oldText === null ? `Created plan ${theme}` : `Updated plan ${theme}`,
    locations: [{ path }],
    ok: true,
  };
}

function normalizeTheme(
  raw: unknown,
): { ok: true; theme: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "missing 'theme'" };
  const input = raw.trim();
  if (!input) return { ok: false, error: "missing 'theme'" };

  const theme = input.endsWith(".md") ? input.slice(0, -3).trim() : input;

  if (!theme) return { ok: false, error: "missing 'theme'" };
  if (theme === "." || theme === "..") {
    return { ok: false, error: "theme must be a file name stem, not a path" };
  }
  if (/[<>:"/\\|?*\x00-\x1F]/.test(theme)) {
    return {
      ok: false,
      error: "theme must not contain path separators or invalid filename characters",
    };
  }

  return { ok: true, theme };
}

export const makePlanTool: Tool = {
  name: "MakePlan",
  tier: "write",
  spec,
  execute,
};
