// Model discovery: ping each provider's GET /v1/models endpoint to discover
// available models. Non-blocking: failures warn and skip, never crash startup.
//
// The response is parsed as OpenAI-compatible { data: [{ id, owned_by }] }.
// Providers that don't support this endpoint get an empty model list; explicitly
// configured models in providers.json are always included regardless.

import { createLogger } from "../log.js";
import { isNonChatModel, lookupModelInfo, type ModelInfo } from "./model-knowledge.js";
import type { ProviderConfig } from "./providers.js";

const log = createLogger("discovery");

// ── Types ─────────────────────────────────────────────────────────────

export interface DiscoveredModel {
  /** Model id as reported by the provider (e.g. "gpt-4o", "deepseek-chat"). */
  id: string;
  /** owner field from the API response (e.g. "openai", "deepseek"). */
  ownedBy?: string;
  /** Enriched metadata from knowledge base (undefined if model is unknown). */
  info?: ModelInfo;
}

export interface DiscoveryResult {
  providerName: string;
  /** Models discovered via /v1/models (empty array on failure). */
  models: DiscoveredModel[];
  /** Error message if discovery failed; undefined on success. */
  error?: string;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
}

// ── Single provider discovery ─────────────────────────────────────────

/** Timeout for each /v1/models request (ms). */
const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Discover available models from a single provider via GET {baseUrl}/models.
 * Returns an empty model list (not an error) if the endpoint is unavailable.
 */
export async function discoverModels(
  config: ProviderConfig,
): Promise<DiscoveryResult> {
  const startedAt = Date.now();
  const url = `${config.baseUrl}/models`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const latencyMs = Date.now() - startedAt;
      const text = await resp.text().catch(() => "");
      log.warn("discovery: HTTP error", {
        provider: config.name,
        url,
        status: resp.status,
        latencyMs,
        body: text.slice(0, 200),
      });
      return {
        providerName: config.name,
        models: [],
        error: `HTTP ${resp.status}: ${text.slice(0, 100)}`,
        latencyMs,
      };
    }

    // OpenAI-compatible: { object: "list", data: [{ id, object, owned_by }] }
    const data = (await resp.json()) as {
      data?: Array<{ id?: string; owned_by?: string }>;
    };

    const rawModels: DiscoveredModel[] = (data.data ?? [])
      .filter((m): m is { id: string; owned_by?: string } => typeof m?.id === "string")
      .map((m) => ({
        id: m.id,
        ...(m.owned_by ? { ownedBy: m.owned_by } : {}),
      }));

    // Filter out non-chat models (TTS, ASR, embedding, etc.) and enrich
    // with knowledge base metadata.
    const skipped: string[] = [];
    const models: DiscoveredModel[] = [];
    for (const m of rawModels) {
      if (isNonChatModel(m.id)) {
        skipped.push(m.id);
        continue;
      }
      const info = lookupModelInfo(m.id);
      models.push(info ? { ...m, info } : m);
    }

    const latencyMs = Date.now() - startedAt;
    log.info("discovery: success", {
      provider: config.name,
      count: models.length,
      models: models.map((m) => m.id),
      ...(skipped.length > 0 ? { skippedNonChat: skipped } : {}),
      latencyMs,
    });

    return { providerName: config.name, models, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    // AbortError = timeout — expected for providers that don't support /models
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    log[isTimeout ? "warn" : "warn"]("discovery: failed", {
      provider: config.name,
      error: message,
      latencyMs,
    });
    return {
      providerName: config.name,
      models: [],
      error: message,
      latencyMs,
    };
  }
}

// ── Multi-provider discovery ──────────────────────────────────────────

/**
 * Discover models from all providers in parallel.
 * Individual failures don't affect other providers.
 */
export async function discoverAllModels(
  configs: ProviderConfig[],
): Promise<DiscoveryResult[]> {
  log.info("discovery: starting", {
    providers: configs.map((c) => c.name),
  });
  const results = await Promise.all(configs.map((c) => discoverModels(c)));
  const total = results.reduce((sum, r) => sum + r.models.length, 0);
  const failed = results.filter((r) => r.error).length;
  log.info("discovery: complete", {
    totalModels: total,
    providers: results.length,
    failed,
  });
  return results;
}
