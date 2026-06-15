# Multi-Provider LLM Configuration

## Goal
Support multiple LLM providers (Mimo, DeepSeek, OpenAI, etc.) simultaneously, each with its own API key and base URL. On startup, ping each provider's `/v1/models` endpoint to discover available models and expose them in the model dropdown.

## Current State
- Single provider via `INVOX_API_KEY` + `INVOX_BASE_URL` env vars
- `OpenAIProvider` wraps the OpenAI SDK — already works with any OAI-compatible endpoint
- `pickProvider()` and `pickModels()` in `cli.ts` build a single `LLMProvider` + `AgentModelConfig`

## Design

### Configuration: `.invox/providers.json`
```json
{
  "providers": [
    { "name": "Mimo",      "baseUrl": "https://...", "apiKey": "tp-xxx" },
    { "name": "DeepSeek",  "baseUrl": "https://...", "apiKey": "sk-xxx" },
    { "name": "OpenAI",    "baseUrl": "https://...", "apiKey": "sk-xxx" }
  ],
  "defaultModel": "mimo-v2.5"
}
```
- `apiKey` supports `$ENV_VAR` syntax for env var references
- Optional `models: string[]` per provider to skip discovery
- `providers.json` present → multi-provider mode; absent → legacy env-var mode (fully backward compatible)

### Architecture

```
src/llm/
  providers.ts        NEW  Provider config types + JSON/env loading
  discovery.ts        NEW  GET /v1/models per provider (5s timeout)
  multi-provider.ts   NEW  Routes stream() to correct provider by model id
  types.ts            (unchanged)
  openai.ts           (unchanged)
```

### MultiProvider
- Implements `LLMProvider` interface
- Holds `Map<modelId, { provider: OpenAIProvider, rawModelId }>` routing table
- `stream(req)` → looks up `req.model` → delegates to the right `OpenAIProvider`
- Duplicate model ids across providers → prefix with `ProviderName/`

### Discovery
- `GET {baseUrl}/models` with Bearer auth, 5s timeout
- Parses `{ data: [{ id, owned_by }] }` (OpenAI-compatible format)
- Failures are non-blocking: warn + skip provider, continue with others
- Models explicitly listed in config are always included (even if discovery fails)

### CLI Changes
- `pickProvider()` → async `buildProviderAndModels()`:
  1. Check mock providers (unchanged)
  2. Load `providers.json` → if present, discover + build `MultiProvider`
  3. Fall back to legacy `INVOX_API_KEY` + `INVOX_BASE_URL`
- `pickModels()` → merge with discovered models when multi-provider is active

### Model Dropdown
```
Mimo / mimo-v2.5-pro    (providerName / modelId)
Mimo / mimo-v2.5
DeepSeek / deepseek-chat
OpenAI / gpt-4o
```
Display `name = "Provider / modelId"`, `modelId = raw model id` (sent to API).

## Files to Create
1. `src/llm/providers.ts` — ProviderConfig, loadProvidersJson, loadProviderFromEnv
2. `src/llm/discovery.ts` — discoverModels, discoverAllModels
3. `src/llm/multi-provider.ts` — MultiProvider class

## Files to Modify
4. `src/cli.ts` — async buildProviderAndModels(), wire MultiProvider

## Config Template
5. `.invox/providers.json` — Example with the user's known providers

## Verification
1. `npm run typecheck` — no type errors
2. `npm test` — existing tests pass
3. Manual: create `.invox/providers.json`, start invox, check stderr logs for discovery results
