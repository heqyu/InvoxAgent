# Plan: Move PRO/LITE into providers.json with merge semantics

## User Story

As an InvoxAgent user, I want agent model tiers (PRO/LITE) configured in providers.json alongside provider credentials, so that all model-related config lives in one place and I don't need scattered env vars.

## Goal

Move `INVOX_MODEL_PRO` / `INVOX_MODEL_LITE` from env vars into `providers.json` under `agentModels.PRO` / `agentModels.LITE`. Two-level merge: project + user providers.json merge at field level; project wins on conflict. Env vars become fallback.

Spec: `specs/agent-models-in-providers-json.feature`

**Test strategy**: vitest, tests in `tests/unit/`, run with `npx vitest run tests/unit/providers.test.ts tests/unit/agent-templates.test.ts`

## 1. Categorization

Config-layer refactoring. Generic skeleton:
Schema change → merge logic → consumer update → cleanup → tests.

## 2. Core data structures

**ProvidersFileConfig** — extend with `agentModels`:

```typescript
// providers.ts
export interface AgentModelsConfig {
  PRO?: string;
  LITE?: string;
}

export interface ProvidersFileConfig {
  providers: ProviderConfig[];
  defaultModel?: string;
  agentModels?: AgentModelsConfig;  // NEW
}
```

**resolveAgentModel** — change signature to accept `AgentModelsConfig`:

```typescript
// model-resolver.ts
export function resolveAgentModel(
  modelField: string | undefined,
  fallback: string,
  agentModels?: AgentModelsConfig,  // NEW: primary source
  env: NodeJS.ProcessEnv = process.env,  // fallback for $ANY_VAR
): string
```

## 3. Staged plan

### Stage 1: Schema + merge in providers.ts
- Add `AgentModelsConfig` interface
- Add `agentModels` to `ProvidersFileConfig`
- Parse `agentModels` in `parseProvidersFile` (validate: only `PRO`/`LITE` string keys)
- Implement `mergeProvidersFiles(user, project)`: providers merged by name (project wins), `defaultModel` project wins, `agentModels` field-merged (project wins on key conflict)
- Change `loadProvidersJson` to two-file lookup + merge instead of first-found-wins
- **Tests**: merge scenarios for providers, defaultModel, agentModels
- **Verify**: `npx vitest run tests/unit/providers.test.ts`

### Stage 2: resolveAgentModel reads agentModels
- Add `agentModels` parameter to `resolveAgentModel`
- `$MODEL_PRO`: `agentModels?.PRO` → fallback to env (`readEnvModelPro`)
- `$MODEL_LITE`: `agentModels?.LITE` → fallback to env (`readEnvModelLite`)
- `$ANY_VAR`: unchanged (env only)
- Update `model-resolver.ts` exports: remove `readEnvModelPro/Lite` from public API
- Update `templates/index.ts` barrel exports
- **Tests**: rewrite PRO/LITE resolution tests to use `agentModels` param
- **Verify**: `npx vitest run tests/unit/agent-templates.test.ts`

### Stage 3: Wire agentModels through CLI → AgentModelConfig
- `AgentModelConfig` in `session-types.ts`: add `agentModels?: AgentModelsConfig`
- `buildProviderAndModels` in `cli.ts`: pass `agentModels` from providers config into `AgentModelConfig`
- `ConfigRouter.applyAgentModel`: pass `session.agentModels` to `resolveAgentModel`
- Remove `readEnvModelPro/Lite` calls from `cli.ts` and `provider-pick.ts`
- **Tests**: smoke test passes with providers.json
- **Verify**: `npx vitest run tests/unit/providers.test.ts tests/unit/agent-templates.test.ts`

### Stage 4: Cleanup + update tests
- Remove `MODEL_PRO_ENV_PRIMARY/ALIAS` and `MODEL_LITE_ENV_PRIMARY/ALIAS` from public export
- Update `agent-templates.test.ts`: keep env var fallback tests
- Update `smoke-agents.ts`: switch from `INVOX_MODEL_PRO/LITE` env vars to providers.json with `agentModels`
- Update `cli.ts` help text
- **Verify**: `npx vitest run tests/unit/agent-templates.test.ts tests/unit/providers.test.ts`

### Stage 5: Merge providers array by name (unit tests)
- Unit tests for providers array merge scenarios (dedup by name, project wins)
- Unit tests for `defaultModel` merge (project wins)
- **Verify**: `npx vitest run tests/unit/providers.test.ts`

## 4. Decision log

| Decision | Why |
|---|---|
| Keep env var fallback for $MODEL_PRO/$MODEL_LITE | Backward compat: existing env var users don't break |
| `agentModels` is optional in schema | Graceful degradation: providers.json without agentModels still works |
| Merge providers by `name` field | Unique natural key; same name = same provider, project customization wins |
| Validate agentModels keys (only PRO/LITE) | Prevent typos from silently doing nothing |
| env vars ignored when agentModels is present | Clear precedence: explicit config beats implicit env |

## 5. Known pitfalls

| Pitfall | Mitigation |
|---|---|
| `agentModels.PRO` id not in provider model list | `multi-provider.ts` auto-injects into modelList (existing) |
| User writes `"agentModels": "gpt-4o"` (string not object) | Schema validation: warn + ignore |
| project providers.json absent, user exists | mergeProvidersFiles: only user contributes, no error |

## 6. Risks & open questions

1. **Existing smoke test uses `INVOX_MODEL_PRO/LITE` env vars** — must migrate to providers.json. Confidence: high.
2. **`$ANY_VAR` generic env resolution** — orthogonal, preserved unchanged. Confidence: high.
3. **`INVOX_MODEL/INVOX_MODELS` removal** — flagged for follow-up PR, not in this scope.

## 7. Scenario-to-stage mapping

| Feature scenario | Stage verified |
|---|---|
| providers.json accepts agentModels | Stage 1 |
| providers.json without agentModels valid | Stage 1 |
| Only user-level exists | Stage 1 |
| Only project-level exists | Stage 1 |
| Different keys merged | Stage 1 + 5 |
| Conflicting keys, project wins | Stage 1 + 5 |
| Neither has agentModels | Stage 1 |
| resolveAgentModel reads agentModels | Stage 2 |
| resolveAgentModel falls back when unset | Stage 2 |
| $MODEL_LITE resolves | Stage 2 |
| $ANY_VAR resolves from env | Stage 2 |
| Env vars ignored when agentModels present | Stage 2 |
| Env vars work when no agentModels | Stage 2 |
| Providers arrays merged by name, project wins | Stage 5 |
| Providers with different names both included | Stage 5 |
