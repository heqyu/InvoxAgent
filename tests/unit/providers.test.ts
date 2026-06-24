import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadProvidersJson,
  mergeProvidersFiles,
  type ProvidersFileConfig,
} from "../../src/llm/providers.js";

// ── Helpers ────────────────────────────────────────────────────────────

function writeProviders(dir: string, config: Record<string, unknown>): void {
  const dirPath = join(dir, ".invox");
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, "providers.json"), JSON.stringify(config));
}

// ── loadProvidersJson ──────────────────────────────────────────────────

describe("providers", () => {
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "invox-providers-user-"));
    projectDir = mkdtempSync(join(tmpdir(), "invox-providers-proj-"));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("loadProvidersJson", () => {
    it("returns null for non-existent paths", () => {
      // Pass isolated dirs that have no providers.json in either location
      expect(loadProvidersJson("/nonexistent/cwd", "/nonexistent/user")).toBeNull();
    });

    it("only user-level exists — use as-is", () => {
      writeProviders(userDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
      });
      // projectDir has no providers.json; userDir does
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.providers).toHaveLength(1);
      expect(result!.providers[0]!.name).toBe("A");
    });

    it("only project-level exists — use as-is", () => {
      writeProviders(projectDir, {
        providers: [{ name: "B", baseUrl: "https://b.com", apiKey: "k" }],
      });
      // projectDir has providers.json; userDir does not
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.providers).toHaveLength(1);
      expect(result!.providers[0]!.name).toBe("B");
    });

    it("both exist — providers merged by name, project wins on conflict", () => {
      writeProviders(userDir, {
        providers: [
          { name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "user-key" },
          { name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "ds-key" },
        ],
      });
      writeProviders(projectDir, {
        providers: [
          { name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "proj-key" },
          { name: "Mimo", baseUrl: "https://mimo.com", apiKey: "mimo-key" },
        ],
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.providers).toHaveLength(3);

      const openai = result!.providers.find((p) => p.name === "OpenAI");
      expect(openai!.apiKey).toBe("proj-key"); // project wins

      const deepseek = result!.providers.find((p) => p.name === "DeepSeek");
      expect(deepseek).toBeDefined(); // user-only, preserved

      const mimo = result!.providers.find((p) => p.name === "Mimo");
      expect(mimo).toBeDefined(); // project-only, included
    });

    it("defaultModel — project wins", () => {
      writeProviders(userDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
        defaultModel: "user-model",
      });
      writeProviders(projectDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
        defaultModel: "proj-model",
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.defaultModel).toBe("proj-model");
    });

    it("defaultModel — only user set", () => {
      writeProviders(userDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
        defaultModel: "user-model",
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.defaultModel).toBe("user-model");
    });
  });

  // ── agentModels scenarios ──────────────────────────────────────────

  describe("agentModels", () => {
    it("accepts agentModels.PRO and agentModels.LITE", () => {
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: "claude-3-5-sonnet", LITE: "gpt-4o-mini" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.agentModels).toEqual({
        PRO: "claude-3-5-sonnet",
        LITE: "gpt-4o-mini",
      });
    });

    it("without agentModels field — valid, agentModels is undefined", () => {
      writeProviders(projectDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.agentModels).toBeUndefined();
    });

    it("only user-level has agentModels", () => {
      writeProviders(userDir, {
        providers: [],
        agentModels: { PRO: "user-pro", LITE: "user-lite" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.agentModels).toEqual({
        PRO: "user-pro",
        LITE: "user-lite",
      });
    });

    it("different keys merged — user PRO + project LITE", () => {
      writeProviders(userDir, {
        providers: [],
        agentModels: { PRO: "user-pro" },
      });
      writeProviders(projectDir, {
        providers: [],
        agentModels: { LITE: "proj-lite" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.agentModels).toEqual({
        PRO: "user-pro",
        LITE: "proj-lite",
      });
    });

    it("conflicting keys — project wins", () => {
      writeProviders(userDir, {
        providers: [],
        agentModels: { PRO: "user-pro", LITE: "user-lite" },
      });
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: "proj-pro" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.agentModels).toEqual({
        PRO: "proj-pro",
        LITE: "user-lite",
      });
    });

    it("neither has agentModels — undefined", () => {
      writeProviders(userDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
      });
      writeProviders(projectDir, {
        providers: [{ name: "B", baseUrl: "https://b.com", apiKey: "k" }],
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.agentModels).toBeUndefined();
    });

    it("ignores unknown keys in agentModels", () => {
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: "claude-3-opus", UNKNOWN: "bad" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result!.agentModels).toEqual({ PRO: "claude-3-opus" });
    });

    it("non-string values in agentModels are ignored → returns null if no valid config", () => {
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: 123, LITE: null },
      });
      // Both invalid → no valid keys, no valid providers → null
      expect(loadProvidersJson(projectDir, userDir)).toBeNull();
    });

    it("empty string values are ignored → returns null if no valid config", () => {
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: "", LITE: "" },
      });
      // Empty strings filtered → no valid agentModels, no valid providers → null
      expect(loadProvidersJson(projectDir, userDir)).toBeNull();
    });

    it("agentModels-only file (no providers) is valid", () => {
      writeProviders(projectDir, {
        providers: [],
        agentModels: { PRO: "claude-3-opus" },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.providers).toHaveLength(0);
      expect(result!.agentModels).toEqual({ PRO: "claude-3-opus" });
    });

    it("agentModels as wrong type (string) is ignored → falls back to providers", () => {
      writeProviders(projectDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
        agentModels: "gpt-4o",
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.providers).toHaveLength(1);
      expect(result!.agentModels).toBeUndefined(); // string ignored
    });

    it("non-string agentModels values ignored → falls back to providers", () => {
      writeProviders(projectDir, {
        providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
        agentModels: { PRO: 123, LITE: null },
      });
      const result = loadProvidersJson(projectDir, userDir);
      expect(result).not.toBeNull();
      expect(result!.agentModels).toBeUndefined(); // invalid values ignored
    });
  });
});

// ── mergeProvidersFiles unit tests ─────────────────────────────────────

describe("mergeProvidersFiles", () => {
  it("both null → empty providers, no agentModels", () => {
    const result = mergeProvidersFiles(null, null);
    expect(result.providers).toHaveLength(0);
    expect(result.agentModels).toBeUndefined();
  });

  it("only user → user's config", () => {
    const user: ProvidersFileConfig = {
      providers: [{ name: "A", baseUrl: "https://a.com", apiKey: "k" }],
      agentModels: { PRO: "user-pro" },
    };
    const result = mergeProvidersFiles(user, null);
    expect(result.providers).toHaveLength(1);
    expect(result.agentModels).toEqual({ PRO: "user-pro" });
  });

  it("only project → project's config", () => {
    const project: ProvidersFileConfig = {
      providers: [{ name: "B", baseUrl: "https://b.com", apiKey: "k" }],
      agentModels: { LITE: "proj-lite" },
    };
    const result = mergeProvidersFiles(null, project);
    expect(result.providers).toHaveLength(1);
    expect(result.agentModels).toEqual({ LITE: "proj-lite" });
  });

  it("providers deduped by name, project wins", () => {
    const user: ProvidersFileConfig = {
      providers: [
        { name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "u" },
        { name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "u" },
      ],
    };
    const project: ProvidersFileConfig = {
      providers: [
        { name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "p" },
        { name: "Mimo", baseUrl: "https://mimo.com", apiKey: "p" },
      ],
    };
    const result = mergeProvidersFiles(user, project);
    expect(result.providers).toHaveLength(3);
    expect(result.providers.find((p) => p.name === "OpenAI")!.apiKey).toBe("p");
    expect(result.providers.find((p) => p.name === "DeepSeek")).toBeDefined();
    expect(result.providers.find((p) => p.name === "Mimo")).toBeDefined();
  });

  it("defaultModel — project wins", () => {
    const user: ProvidersFileConfig = {
      providers: [],
      defaultModel: "user-model",
    };
    const project: ProvidersFileConfig = {
      providers: [],
      defaultModel: "proj-model",
    };
    expect(mergeProvidersFiles(user, project).defaultModel).toBe("proj-model");
  });

  it("defaultModel — only user", () => {
    const user: ProvidersFileConfig = {
      providers: [],
      defaultModel: "user-model",
    };
    expect(mergeProvidersFiles(user, null).defaultModel).toBe("user-model");
  });

  it("agentModels — field-merged, project wins per key", () => {
    const user: ProvidersFileConfig = {
      providers: [],
      agentModels: { PRO: "user-pro", LITE: "user-lite" },
    };
    const project: ProvidersFileConfig = {
      providers: [],
      agentModels: { PRO: "proj-pro" },
    };
    expect(mergeProvidersFiles(user, project).agentModels).toEqual({
      PRO: "proj-pro",
      LITE: "user-lite",
    });
  });

  it("agentModels — different keys merged", () => {
    const user: ProvidersFileConfig = {
      providers: [],
      agentModels: { PRO: "user-pro" },
    };
    const project: ProvidersFileConfig = {
      providers: [],
      agentModels: { LITE: "proj-lite" },
    };
    expect(mergeProvidersFiles(user, project).agentModels).toEqual({
      PRO: "user-pro",
      LITE: "proj-lite",
    });
  });
});
