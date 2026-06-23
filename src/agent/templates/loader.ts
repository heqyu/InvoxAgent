import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { createLogger } from "../../log.js";
const log = createLogger("templates");
import type { AgentTemplate } from "./types.js";
import { BUILTIN_AGENTS } from "./builtin.js";
import { seedDefaultAgents } from "./seed.js";

// ── 加载器 ────────────────────────────────────────────────────────────

const AGENT_DIR = join(".invox", "agents");

/**
 * 扫描某个根目录下的 .invox/agents/*.json，把文件解析成 AgentTemplate[]。
 * 解析失败的文件仅 warn 跳过；目录不存在直接返回空数组。
 *
 * 文件 schema：
 *   {
 *     "name": "Plan",                    // 必填
 *     "description": "...",              // 可选
 *     "prompt": "You are ...",           // 必填
 *     "tools": ["Read","Glob"],          // 可选
 *     "mcp": false                       // 可选，默认 true
 *   }
 *
 * 文件名（去 .json）作为 id —— 与 .invox/sessions/ 保持同惯例。
 * 文件内若再写 "id" 字段会被忽略，避免双源歧义。
 */
function loadAgentsFromDir(rootDir: string): AgentTemplate[] {
  const dir = join(rootDir, AGENT_DIR);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    log.warn("agents: cannot list dir", {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }

  const out: AgentTemplate[] = [];
  for (const name of entries) {
    if (extname(name) !== ".json") continue;
    const filePath = join(dir, name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const id = name.slice(0, -5); // 去 .json
    if (!isValidAgentId(id)) {
      log.warn("agents: skipping file with invalid id", { filePath, id });
      continue;
    }
    const tpl = parseAgentFile(filePath, id);
    if (tpl) out.push(tpl);
  }
  return out;
}

/** id 必须是非空 ASCII 安全字符 —— 作为下拉 value + ACP wire 字段。 */
function isValidAgentId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

function parseAgentFile(filePath: string, id: string): AgentTemplate | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    log.warn("agents: read failed", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn("agents: invalid JSON", {
      filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("agents: file is not a JSON object", { filePath });
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (typeof r["prompt"] !== "string" || r["prompt"].length === 0) {
    log.warn("agents: missing or empty 'prompt' field", { filePath });
    return null;
  }

  const tpl: AgentTemplate = {
    id,
    name:
      typeof r["name"] === "string" && r["name"].length > 0 ? r["name"] : id,
    prompt: r["prompt"] as string,
  };
  if (typeof r["description"] === "string") {
    tpl.description = r["description"];
  }
  if (Array.isArray(r["tools"])) {
    // 显式空数组 = 禁用全部，是合法语义；undefined 才表示"未设置 = 全部"。
    const tools: string[] = [];
    for (const t of r["tools"]) {
      if (typeof t === "string" && t.length > 0) tools.push(t);
    }
    tpl.tools = tools;
  }
  if (typeof r["mcp"] === "boolean") {
    tpl.mcp = r["mcp"];
  }
  if (typeof r["model"] === "string" && r["model"].length > 0) {
    tpl.model = r["model"];
  }
  return tpl;
}

/**
 * 加载所有 agent 模板：项目级 + 用户级 + 内置 —— 按 id 去重，**项目级覆盖
 * 用户级，用户级覆盖内置**。返回数组保持 [项目, 用户独有, 内置独有] 的稳定顺序，
 * 让下拉项位置随用户预期。
 *
 * 至少返回 BUILTIN_AGENTS（Worker）—— 任何路径都不会返回空数组。
 */
export function loadAgentTemplates(cwd: string): AgentTemplate[] {
  // 首次加载时自动 seed 用户目录默认配置（Plan / Ask / CodeReviewer）
  seedDefaultAgents();

  const projectAgents = loadAgentsFromDir(cwd);
  const userAgents = loadAgentsFromDir(homedir());

  const seen = new Set<string>();
  const out: AgentTemplate[] = [];
  // 项目级先入（最高优先）
  for (const a of projectAgents) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push({ ...a, source: "project" });
    }
  }
  // 用户级补漏
  for (const a of userAgents) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push({ ...a, source: "user" });
    }
  }
  // 内置兜底
  for (const a of BUILTIN_AGENTS) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push({ ...a, source: "builtin" });
    }
  }

  log.info("agents loaded", {
    cwd,
    total: out.length,
    project: projectAgents.length,
    user: userAgents.length,
    ids: out.map((a) => a.id),
  });
  return out;
}
