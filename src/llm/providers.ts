// Multi-provider configuration: load provider configs from .invox/providers.json.
//
// Two-level lookup (project → user):
//   1. <cwd>/.invox/providers.json — project-level (full precedence)
//   2. ~/.invox/providers.json     — user-level default
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

export interface ProvidersFileConfig {
  providers: ProviderConfig[];
  /** Default model ID across all providers. Falls back to first discovered model. */
  defaultModel?: string;
}

// ── JSON config loading ───────────────────────────────────────

/**
 * Load multi-provider config with two-level lookup (project → user).
 *
 *   1. `<cwd>/.invox/providers.json` — project-level (full precedence)
 *   2. `~/.invox/providers.json`     — user-level default
 *   3. null                           — neither found → legacy env-var path
 *
 * apiKey supports $ENV_VAR syntax: value starting with "$" is resolved from process.env.
 */
export function loadProvidersJson(cwd: string): ProvidersFileConfig | null {
  const projectFile = join(cwd, ".invox", "providers.json");
  if (existsSync(projectFile)) {
    const result = parseProvidersFile(projectFile);
    if (result) return result;
  }

  // User-level fallback: ~/.invox/providers.json
  const userFile = join(homedir(), ".invox", "providers.json");
  if (existsSync(userFile)) {
    const result = parseProvidersFile(userFile);
    if (result) return result;
  }

  return null;
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
