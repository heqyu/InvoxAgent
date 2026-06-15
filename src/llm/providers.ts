// Multi-provider configuration: load provider configs from JSON file or env vars.
//
// Two modes:
//   1. Multi-provider — .invox/providers.json (JSON config with multiple providers)
//   2. Legacy single  — INVOX_API_KEY + INVOX_BASE_URL env vars
//
// providers.json takes precedence when present.
// apiKey supports $ENV_VAR syntax: value starting with "$" is resolved from process.env.

import { existsSync, readFileSync } from "node:fs";
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
}

export interface ProvidersFileConfig {
  providers: ProviderConfig[];
  /** Default model ID across all providers. Falls back to first discovered model. */
  defaultModel?: string;
}

// ── JSON config loading ───────────────────────────────────────────────

/**
 * Load multi-provider config from .invox/providers.json.
 * Returns null if the file doesn't exist or is invalid.
 *
 * Schema:
 * {
 *   "providers": [
 *     { "name": "Mimo", "baseUrl": "...", "apiKey": "..." },
 *     { "name": "DeepSeek", "baseUrl": "...", "apiKey": "$DEEPSEEK_KEY" }
 *   ],
 *   "defaultModel": "mimo-v2.5"
 * }
 */
export function loadProvidersJson(cwd: string): ProvidersFileConfig | null {
  const file = join(cwd, ".invox", "providers.json");
  if (!existsSync(file)) return null;

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

    providers.push({
      name: pr["name"] as string,
      baseUrl: (pr["baseUrl"] as string).replace(/\/+$/, ""),
      apiKey: resolveEnvRef(pr["apiKey"] as string),
      ...(Array.isArray(pr["models"]) && (pr["models"] as unknown[]).length > 0
        ? { models: (pr["models"] as unknown[]).filter((m): m is string => typeof m === "string" && m.length > 0) }
        : {}),
    });
  }

  if (providers.length === 0) {
    log.warn("providers.json: no valid providers found after filtering", { file });
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
  };
}

// ── Env var fallback (backward compatible) ────────────────────────────

/**
 * Build a single-provider config from legacy env vars.
 * Returns null if either INVOX_API_KEY or INVOX_BASE_URL is missing.
 */
export function loadProviderFromEnv(): ProviderConfig | null {
  const apiKey = process.env["INVOX_API_KEY"];
  const baseUrl = process.env["INVOX_BASE_URL"];
  if (!apiKey || !baseUrl) return null;

  const model = process.env["INVOX_MODEL"];
  return {
    name: "default",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    ...(model ? { models: [model] } : {}),
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
