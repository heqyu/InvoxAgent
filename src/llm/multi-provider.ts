// MultiProvider: routes LLM stream() requests to the correct underlying
// OpenAIProvider based on the model id in the request.
//
// One MultiProvider replaces a single OpenAIProvider when the user configures
// multiple providers in .invox/providers.json. The model dropdown lists all
// discovered models; each stream() call is dispatched to the provider that owns
// the requested model.
//
// Duplicate model ids across providers are prefixed with "ProviderName/" to
// keep the routing unambiguous.

import { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";
import type { LLMProvider, LLMRequest, LLMDelta } from "./types.js";
import type { ProviderConfig } from "./providers.js";
import type { DiscoveryResult } from "./discovery.js";
import { createLogger } from "../log.js";

const log = createLogger("multi-provider");

// ── Internal types ────────────────────────────────────────────────────

interface ProviderEntry {
  name: string;
  provider: OpenAIProvider;
  /** Raw model ids this provider owns (no prefix). */
  rawModelIds: Set<string>;
}

interface ModelRouting {
  entry: ProviderEntry;
  /** The actual model id the provider API expects. */
  rawModelId: string;
}

// ── Config ────────────────────────────────────────────────────────────

export interface MultiProviderSetup {
  providers: Array<{
    config: ProviderConfig;
    discovery: DiscoveryResult;
  }>;
  /** Preferred default model id. Falls back to first available. */
  defaultModel?: string;
}

// ── MultiProvider ─────────────────────────────────────────────────────

export class MultiProvider implements LLMProvider {
  readonly name = "multi";
  private entries: ProviderEntry[] = [];
  private routing = new Map<string, ModelRouting>();
  private _defaultModel: string;

  constructor(setup: MultiProviderSetup) {
    const allModelIds: string[] = [];

    for (const { config, discovery } of setup.providers) {
      // Merge: discovery results + explicitly configured models (config takes precedence)
      const discoveredIds = discovery.models.map((m) => m.id);
      const explicitIds = config.models ?? [];
      // Union: explicitly listed models are always included
      const modelIds = [
        ...new Set([...explicitIds, ...discoveredIds]),
      ];

      if (modelIds.length === 0) {
        log.warn("multi-provider: provider has no models, skipping", {
          name: config.name,
          discoveryError: discovery.error,
        });
        continue;
      }

      const provider = new OpenAIProvider({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        // Default model for this provider: first in the list
        model: modelIds[0]!,
      } satisfies OpenAIProviderConfig);

      const entry: ProviderEntry = {
        name: config.name,
        provider,
        rawModelIds: new Set(modelIds),
      };
      this.entries.push(entry);

      // Register each model in the routing table.
      // If a model id already exists (duplicate across providers), prefix it.
      for (const id of modelIds) {
        const existing = this.routing.get(id);
        if (existing) {
          // Duplicate — prefix both the existing entry and this one
          const existingPrefixed = `${existing.entry.name}/${id}`;
          const newPrefixed = `${config.name}/${id}`;

          // Re-register existing with prefix
          this.routing.set(existingPrefixed, {
            entry: existing.entry,
            rawModelId: id,
          });
          this.routing.delete(id);

          // Register new with prefix
          this.routing.set(newPrefixed, { entry, rawModelId: id });
          allModelIds.push(newPrefixed);

          log.info("multi-provider: duplicate model id, prefixed both", {
            modelId: id,
            existingProvider: existing.entry.name,
            newProvider: config.name,
            existingPrefixed,
            newPrefixed,
          });
        } else {
          this.routing.set(id, { entry, rawModelId: id });
          allModelIds.push(id);
        }
      }
    }

    // Resolve default model
    if (setup.defaultModel && this.routing.has(setup.defaultModel)) {
      this._defaultModel = setup.defaultModel;
    } else {
      this._defaultModel = allModelIds[0] ?? "unknown";
    }

    log.info("multi-provider: initialized", {
      providers: this.entries.map((e) => ({
        name: e.name,
        modelCount: e.rawModelIds.size,
        models: [...e.rawModelIds],
      })),
      defaultModel: this._defaultModel,
      totalModels: allModelIds.length,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** The default model id (first available or explicitly configured). */
  get defaultModel(): string {
    return this._defaultModel;
  }

  /** All registered model ids (possibly prefixed for duplicates). */
  get availableModelIds(): string[] {
    return [...this.routing.keys()];
  }

  /**
   * Build a human-readable model list for the UI dropdown.
   * name = "ProviderName / modelId" for clarity.
   */
  get modelList(): Array<{ modelId: string; name: string; providerName: string }> {
    const result: Array<{
      modelId: string;
      name: string;
      providerName: string;
    }> = [];

    for (const [displayId, route] of this.routing) {
      // For display: if id was prefixed, use as-is; otherwise add provider prefix
      const wasPrefixed = displayId.includes("/");
      const displayName = wasPrefixed
        ? displayId
        : `${route.entry.name} / ${displayId}`;

      result.push({
        modelId: displayId,
        name: displayName,
        providerName: route.entry.name,
      });
    }

    return result;
  }

  /**
   * Stream an LLM request, routed to the correct provider by model id.
   * Falls back to the first provider if model is unknown.
   */
  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const model = req.model ?? this._defaultModel;
    const route = this.routing.get(model);

    if (!route) {
      // Unknown model — try first provider as fallback
      const fallback = this.entries[0];
      if (!fallback) {
        throw new Error(
          `No provider configured. Cannot serve model "${model}".`,
        );
      }
      log.warn("multi-provider: unknown model, using fallback provider", {
        model,
        fallbackProvider: fallback.name,
      });
      yield* fallback.provider.stream(req);
      return;
    }

    // Delegate to the resolved provider with the raw (unprefixed) model id
    yield* route.entry.provider.stream({ ...req, model: route.rawModelId });
  }
}
