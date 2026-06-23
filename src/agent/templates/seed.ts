import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../log.js";
const log = createLogger("templates");
import type { AgentTemplate } from "./types.js";
import { DEFAULT_USER_AGENTS } from "./builtin.js";

/**
 * 在用户 home 目录下 seed 默认 agent 配置文件。
 * 目录不存在会创建。
 *
 * 写入规则（升级语义）：
 *   - 文件不存在               → 写入完整默认值
 *   - 文件存在且含 model 字段  → 默认尊重用户，跳过
 *   - 文件存在但**缺 model**   → 旧版升级，覆盖写最新模板
 *     （Phase H 引入 model 字段，已部署的旧 seed 文件没这个字段；这条规则
 *      让它一次性升级到带 PRO/LITE 默认的新版本，开发期可控覆盖）
 *   - 默认 Plan seed 缺 MakePlan → 覆盖写最新模板，让 Plan 能落盘方案
 *   - 文件存在但 JSON 损坏     → 视作需要修复，覆盖写
 *
 * 用户已经手动改过 model 字段（甚至改成 null / "$MY_VAR"）就保留，
 * 不会被反复覆盖。
 */
function isLegacyDefaultAskNoRead(
  tpl: Omit<AgentTemplate, "id"> & { id: string },
  parsed: Record<string, unknown>,
): boolean {
  if (tpl.id !== "Ask" || !tpl.tools?.includes("Read")) return false;
  const tools = parsed["tools"];
  // 已包含 Read → 非旧版，跳过
  if (Array.isArray(tools) && tools.includes("Read")) return false;

  const prompt = String(parsed["prompt"] ?? "");
  // 匹配两种旧版 seed prompt 格式：
  //   v1: "You are in ASK MODE.\nYou have NO tools available..."
  //   v2: "You have NO tools available.\nAnswer questions..."
  // 只要 prompt 明确说"没有工具"且 tools 确实为空 → 视为需要升级
  return prompt.includes("NO tools available");
}

function isLegacyDefaultPlanMissingMakePlan(
  tpl: Omit<AgentTemplate, "id"> & { id: string },
  parsed: Record<string, unknown>,
): boolean {
  if (tpl.id !== "Plan" || !tpl.tools?.includes("MakePlan")) return false;
  const tools = parsed["tools"];
  if (!Array.isArray(tools) || tools.includes("MakePlan")) return false;

  const name = String(parsed["name"] ?? "");
  const prompt = String(parsed["prompt"] ?? "");
  return (
    name === "Plan" &&
    prompt.includes("PLAN MODE") &&
    prompt.includes("You have NO write access")
  );
}

export function seedDefaultAgents(): void {
  const userAgentsDir = join(homedir(), ".invox", "agents");
  if (!existsSync(userAgentsDir)) {
    try {
      mkdirSync(userAgentsDir, { recursive: true });
    } catch (e) {
      log.warn("agents: cannot create user agents dir", {
        dir: userAgentsDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  }

  for (const tpl of DEFAULT_USER_AGENTS) {
    const filePath = join(userAgentsDir, `${tpl.id}.json`);

    // 决定是否（重新）写入
    let action:
      | "skip"
      | "create"
      | "upgrade-no-model"
      | "upgrade-plan-makeplan"
      | "upgrade-ask-read"
      | "repair-broken" = "create";
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          action = "repair-broken";
        } else {
          const hasModelKey = "model" in (parsed as Record<string, unknown>);
          // 仅当当前 DEFAULT 有 model 字段、磁盘版本却没有，才视为旧版升级
          // （Ask 模板没 model 字段，遇到旧版也不强行写入）
          if (!hasModelKey && tpl.model) {
            action = "upgrade-no-model";
          } else if (
            isLegacyDefaultAskNoRead(tpl, parsed as Record<string, unknown>)
          ) {
            action = "upgrade-ask-read";
          } else if (
            isLegacyDefaultPlanMissingMakePlan(
              tpl,
              parsed as Record<string, unknown>,
            )
          ) {
            action = "upgrade-plan-makeplan";
          } else {
            action = "skip";
          }
        }
      } catch {
        action = "repair-broken";
      }
    }

    if (action === "skip") continue;

    const body: Record<string, unknown> = {
      name: tpl.name,
      prompt: tpl.prompt,
    };
    if (tpl.description) body.description = tpl.description;
    if (tpl.tools) body.tools = tpl.tools;
    if (tpl.mcp !== undefined) body.mcp = tpl.mcp;
    if (tpl.model) body.model = tpl.model;

    try {
      writeFileSync(filePath, JSON.stringify(body, null, 2) + "\n", "utf8");
      log.info("agents: seeded default agent config", {
        id: tpl.id,
        filePath,
        action,
      });
    } catch (e) {
      log.warn("agents: failed to seed agent config", {
        id: tpl.id,
        filePath,
        action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
