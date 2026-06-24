Feature: Agent model tier (PRO/LITE) configuration via providers.json
  Move INVOX_MODEL_PRO / INVOX_MODEL_LITE from env vars into providers.json
  as `agentModels.PRO` and `agentModels.LITE`, with two-level merge semantics.

  Background:
    Given an InvoxAgent installation with agent templates using "$MODEL_PRO" / "$MODEL_LITE"
    And providers.json supports a two-level lookup: project (<cwd>/.invox/providers.json) and user (~/.invox/providers.json)

  # ── providers.json schema ────────────────────────────────────────

  Scenario: providers.json accepts agentModels.PRO and agentModels.LITE
    Given a providers.json with content:
      """json
      {
        "providers": [],
        "agentModels": { "PRO": "claude-3-5-sonnet", "LITE": "gpt-4o-mini" }
      }
      """
    When loadProvidersJson parses this file
    Then the returned config has agentModels.PRO = "claude-3-5-sonnet"
    And the returned config has agentModels.LITE = "gpt-4o-mini"

  Scenario: providers.json without agentModels field is valid
    Given a providers.json without "agentModels" key
    When loadProvidersJson parses this file
    Then the returned config has agentModels = undefined
    And no error is thrown

  # ── two-level merge: project + user ──────────────────────────────

  Scenario: Only user-level providers.json exists — use it as-is
    Given user-level providers.json has agentModels { "PRO": "user-pro", "LITE": "user-lite" }
    And no project-level providers.json exists
    When loadProvidersJson merges both levels
    Then the result has agentModels.PRO = "user-pro"
    And the result has agentModels.LITE = "user-lite"

  Scenario: Only project-level providers.json exists — use it as-is
    Given project-level providers.json has agentModels { "PRO": "proj-pro", "LITE": "proj-lite" }
    And no user-level providers.json exists
    When loadProvidersJson merges both levels
    Then the result has agentModels.PRO = "proj-pro"
    And the result has agentModels.LITE = "proj-lite"

  Scenario: Both levels exist — different keys are merged
    Given user-level providers.json has agentModels { "PRO": "user-pro" }
    And project-level providers.json has agentModels { "LITE": "proj-lite" }
    When loadProvidersJson merges both levels
    Then the result has agentModels.PRO = "user-pro"
    And the result has agentModels.LITE = "proj-lite"

  Scenario: Both levels exist — conflicting keys, project wins
    Given user-level providers.json has agentModels { "PRO": "user-pro", "LITE": "user-lite" }
    And project-level providers.json has agentModels { "PRO": "proj-pro" }
    When loadProvidersJson merges both levels
    Then the result has agentModels.PRO = "proj-pro"
    And the result has agentModels.LITE = "user-lite"

  Scenario: Neither level has agentModels — result is undefined
    Given user-level providers.json has no agentModels
    And project-level providers.json has no agentModels
    When loadProvidersJson merges both levels
    Then the result has agentModels = undefined

  # ── providers array merge ────────────────────────────────────────

  Scenario: Providers arrays are merged by name — project wins on conflict
    Given user-level providers.json has provider { "name": "OpenAI", "baseUrl": "https://api.openai.com", "apiKey": "user-key" }
    And project-level providers.json has provider { "name": "OpenAI", "baseUrl": "https://api.openai.com", "apiKey": "proj-key" }
    When loadProvidersJson merges both levels
    Then the result has exactly 1 provider named "OpenAI" with apiKey "proj-key"

  Scenario: Providers arrays with different names are both included
    Given user-level providers.json has provider { "name": "DeepSeek", "baseUrl": "...", "apiKey": "..." }
    And project-level providers.json has provider { "name": "Mimo", "baseUrl": "...", "apiKey": "..." }
    When loadProvidersJson merges both levels
    Then the result has 2 providers: "DeepSeek" and "Mimo"

  # ── model resolution (upstream consumer) ─────────────────────────

  Scenario: resolveAgentModel reads agentModels from config, not env vars
    Given agentModels config has { "PRO": "claude-3-opus", "LITE": "gpt-4o-mini" }
    When resolveAgentModel is called with field "$MODEL_PRO"
    Then it returns "claude-3-opus"

  Scenario: resolveAgentModel falls back when agentModels.PRO is unset
    Given agentModels config has { "LITE": "gpt-4o-mini" } (no PRO)
    When resolveAgentModel is called with field "$MODEL_PRO"
    Then it returns the fallback value

  Scenario: $MODEL_LITE resolves from agentModels.LITE
    Given agentModels config has { "LITE": "haiku" }
    When resolveAgentModel is called with field "$MODEL_LITE"
    Then it returns "haiku"

  Scenario: $ANY_VAR still resolves from process.env (generic forward-compat)
    Given no agentModels entry for "CUSTOM"
    When resolveAgentModel is called with field "$MY_CUSTOM_MODEL" and env MY_CUSTOM_MODEL=deepseek-r1
    Then it returns "deepseek-r1"

  # ── backward compatibility ───────────────────────────────────────

  Scenario: Env vars are ignored when agentModels is present in providers.json
    Given INVOX_MODEL_PRO=env-pro is set in environment
    And agentModels.PRO = "json-pro" in providers.json
    When resolveAgentModel is called with field "$MODEL_PRO"
    Then it returns "json-pro" (providers.json wins)

  Scenario: Env vars still work when providers.json has no agentModels
    Given INVOX_MODEL_PRO=env-pro is set in environment
    And agentModels is undefined in providers.json
    When resolveAgentModel is called with field "$MODEL_PRO"
    Then it returns "env-pro" (env var fallback)
