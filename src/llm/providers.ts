// Multi-provider configuration: load provider configs from .invox/providers.json.
//
// Two-level lookup with field-level merge (project overrides user on conflict):
//   1. <cwd>/.invox/providers.json — project-level
//   2. ~/.invox/providers.json     — user-level default
//
// Merge semantics:
//   - providers[]: deduped by `name`, project wins on conflict
//   - defaultModel: project wins
//   - agentModels: field-merged, project wins on key conflict
//
// apiKey supports $ENV_VAR syntax: value starting with "$" is resolved from process.env.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.js";

const log = createLogger("providers");

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderConfig {
  /** Human-readable name shown in model dropdown (e.g. "Mimo", "DeepSeek"). */
  name: string;
  /** OpenAI-compatible base URL (e.g. "https://api.deepseek.com"). */
  baseUrl: string;
  /** API key — plain string or "$ENV_VAR" reference. */
  apiKey: string;
  /**
   * Explicitly listed model IDs. If omitted, discovery via /v1/models is attempted.
   * Useful when the provider doesn't support the models endpoint.
   */
  models?: string[];
  /** Whether this provider is enabled. Defaults to true. Set to false to skip. */
  enabled?: boolean;
}

/**
 * Agent model tier configuration. Maps logical tier names to actual model IDs.
 *
 *   - PRO  : high-reasoning / planning tasks (e.g. Plan, CodeReviewer, BDD agents)
 *   - LITE : execution tasks that follow an existing plan (e.g. Worker agent)
 *
 * Referenced by agent templates via `$MODEL_PRO` / `$MODEL_LITE` placeholders
 * in the `model` field. Resolved at runtime by `resolveAgentModel()`.
 */
export interface AgentModelsConfig {
  PRO?: string;
  LITE?: string;
}

export interface ProvidersFileConfig {
  providers: ProviderConfig[];
  /** Default model ID across all providers. Falls back to first discovered model. */
  defaultModel?: string;
  /**
   * Agent model tier configuration. Merged across user + project levels;
   * project wins on key conflict.
   */
  agentModels?: AgentModelsConfig;
}

// ── JSON config loading ───────────────────────────────────────

/**
 * Load multi-provider config with field-level merge (project → user).
 *
 *   1. `<cwd>/.invox/providers.json` — project-level
 *   2. `~/.invox/providers.json`     — user-level default
 *
 * Merge semantics (project wins on conflict):
 *   - providers[]: deduped by `name`
 *   - defaultModel: project wins
 *   - agentModels: field-merged at key level (PRO / LITE)
 *
 * Returns null only when neither file provides any usable config.
 *
 * apiKey supports $ENV_VAR syntax: value starting with "$" is resolved from process.env.
 */
export function loadProvidersJson(
  cwd: string,
  userDir?: string,
): ProvidersFileConfig | null {
  const projectFile = join(cwd, ".invox", "providers.json");
  const userFile = join(userDir ?? homedir(), ".invox", "providers.json");

  const user = existsSync(userFile) ? parseProvidersFile(userFile) : null;
  const project = existsSync(projectFile) ? parseProvidersFile(projectFile) : null;

  if (!user && !project) return null;
  return mergeProvidersFiles(user, project);
}

/**
 * Parse a single providers.json file. Returns null on any read/parse error.
 */
function parseProvidersFile(file: string): ProvidersFileConfig | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    log.warn("providers.json: cannot read", { file, error: (err as Error).message });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn("providers.json: invalid JSON", { file, error: (err as Error).message });
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>)["providers"])
  ) {
    log.warn("providers.json: missing 'providers' array", { file });
    return null;
  }

  const rec = parsed as Record<string, unknown>;
  const providers: ProviderConfig[] = [];

  for (const p of rec["providers"] as unknown[]) {
    if (!p || typeof p !== "object") continue;
    const pr = p as Record<string, unknown>;

    if (typeof pr["name"] !== "string" || !pr["name"]) continue;
    if (typeof pr["baseUrl"] !== "string" || !pr["baseUrl"]) continue;
    if (typeof pr["apiKey"] !== "string" || !pr["apiKey"]) continue;

    // Skip disabled providers
    if (pr["enabled"] === false) {
      log.info("providers.json: skipping disabled provider", { name: pr["name"] as string });
      continue;
    }

    providers.push({
      name: pr["name"] as string,
      baseUrl: (pr["baseUrl"] as string).replace(/\/+$/, ""),
      apiKey: resolveEnvRef(pr["apiKey"] as string),
      ...(Array.isArray(pr["models"]) && (pr["models"] as unknown[]).length > 0
        ? { models: (pr["models"] as unknown[]).filter((m): m is string => typeof m === "string" && m.length > 0) }
        : {}),
      ...(typeof pr["enabled"] === "boolean" ? { enabled: pr["enabled"] as boolean } : {}),
    });
  }

  // Parse agentModels (optional): only accept "PRO" and "LITE" string keys
  let agentModels: AgentModelsConfig | undefined;
  const rawAM = rec["agentModels"];
  if (rawAM && typeof rawAM === "object" && !Array.isArray(rawAM)) {
    const amRec = rawAM as Record<string, unknown>;
    const valid: AgentModelsConfig = {};
    for (const [k, v] of Object.entries(amRec)) {
      if (k === "PRO" || k === "LITE") {
        if (typeof v === "string" && v.length > 0) {
          valid[k] = v;
        }
      } else {
        log.warn("providers.json: ignoring unknown agentModels key", { file, key: k });
      }
    }
    if (valid.PRO || valid.LITE) agentModels = valid;
  } else if (rawAM !== undefined) {
    log.warn("providers.json: agentModels should be an object, ignoring", { file });
  }

  if (providers.length === 0 && !agentModels) {
    log.warn("providers.json: no valid providers or agentModels found after filtering", { file });
    return null;
  }

  log.info("providers.json: loaded", {
    file,
    count: providers.length,
    names: providers.map((p) => p.name),
  });

  return {
    providers,
    ...(typeof rec["defaultModel"] === "string" && rec["defaultModel"]
      ? { defaultModel: rec["defaultModel"] as string }
      : {}),
    ...(agentModels ? { agentModels } : {}),
  };
}

/**
 * Merge two ProvidersFileConfig with field-level precedence.
 * Project-level values win on conflict; user-level fills gaps.
 *
 *   - providers[]: deduped by `name` (project wins)
 *   - defaultModel: project wins
 *   - agentModels: field-merged (project wins per key: PRO / LITE)
 */
export function mergeProvidersFiles(
  user: ProvidersFileConfig | null,
  project: ProvidersFileConfig | null,
): ProvidersFileConfig {
  // ── providers[]: merge by name, project wins ──────────────────
  const providerByName = new Map<string, ProviderConfig>();
  for (const p of user?.providers ?? []) {
    providerByName.set(p.name, p);
  }
  for (const p of project?.providers ?? []) {
    providerByName.set(p.name, p); // project overwrites same name
  }
  const providers = [...providerByName.values()];

  // ── defaultModel: project wins ────────────────────────────────
  const defaultModel = project?.defaultModel ?? user?.defaultModel;

  // ── agentModels: field-merged, project wins per key ───────────
  let agentModels: AgentModelsConfig | undefined;
  const userAM = user?.agentModels;
  const projAM = project?.agentModels;
  if (userAM || projAM) {
    const merged: AgentModelsConfig = {};
    if (userAM?.PRO) merged.PRO = userAM.PRO;
    if (userAM?.LITE) merged.LITE = userAM.LITE;
    if (projAM?.PRO) merged.PRO = projAM.PRO; // project wins
    if (projAM?.LITE) merged.LITE = projAM.LITE; // project wins
    if (merged.PRO || merged.LITE) agentModels = merged;
  }

  return {
    providers,
    ...(defaultModel ? { defaultModel } : {}),
    ...(agentModels ? { agentModels } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve "$ENV_VAR" references in a string value.
 * If the value starts with "$", look up the env var name (without "$").
 * Env var not set → return empty string (caller should handle).
 */
function resolveEnvRef(value: string): string {
  if (!value.startsWith("$")) return value;
  const varName = value.slice(1);
  const resolved = process.env[varName];
  if (!resolved) {
    log.warn("providers: env var reference unresolved", { ref: value, varName });
    return value; // return the $VAR as-is so the error is visible downstream
  }
  return resolved;
}
