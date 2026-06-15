import { describe, it, expect } from "vitest";
import { MultiProvider } from "../../src/llm/multi-provider.js";
import type { ProviderConfig } from "../../src/llm/providers.js";
import type { DiscoveryResult } from "../../src/llm/discovery.js";

function fakeDiscovery(
  name: string,
  models: string[],
): { config: ProviderConfig; discovery: DiscoveryResult } {
  return {
    config: {
      name,
      baseUrl: "https://fake.example.com/v1",
      apiKey: "fake-key",
    },
    discovery: {
      providerName: name,
      models: models.map((id) => ({ id })),
      latencyMs: 10,
    },
  };
}

describe("MultiProvider", () => {
  it("initializes with single provider", () => {
    const mp = new MultiProvider({
      providers: [fakeDiscovery("Mimo", ["mimo-v2.5", "mimo-v2.5-pro"])],
    });
    expect(mp.name).toBe("multi");
    expect(mp.defaultModel).toBe("mimo-v2.5");
    expect(mp.availableModelIds).toEqual(["mimo-v2.5", "mimo-v2.5-pro"]);
  });

  it("builds model list with provider names", () => {
    const mp = new MultiProvider({
      providers: [fakeDiscovery("Mimo", ["mimo-v2.5"])],
    });
    const list = mp.modelList;
    expect(list).toHaveLength(1);
    expect(list[0]!.modelId).toBe("mimo-v2.5");
    expect(list[0]!.name).toBe("Mimo / mimo-v2.5");
    expect(list[0]!.providerName).toBe("Mimo");
  });

  it("merges explicit models with discovered models", () => {
    const mp = new MultiProvider({
      providers: [
        {
          config: {
            name: "Local",
            baseUrl: "http://localhost:1234/v1",
            apiKey: "lm-studio",
            models: ["extra-model"],
          },
          discovery: {
            providerName: "Local",
            models: [{ id: "discovered-model" }],
            latencyMs: 5,
          },
        },
      ],
    });
    const ids = mp.availableModelIds;
    expect(ids).toContain("extra-model");
    expect(ids).toContain("discovered-model");
  });

  it("prefixes duplicate model ids across providers", () => {
    const mp = new MultiProvider({
      providers: [
        fakeDiscovery("ProviderA", ["shared-model", "unique-a"]),
        fakeDiscovery("ProviderB", ["shared-model", "unique-b"]),
      ],
    });
    const ids = mp.availableModelIds;
    expect(ids).toContain("ProviderA/shared-model");
    expect(ids).toContain("ProviderB/shared-model");
    expect(ids).toContain("unique-a");
    expect(ids).toContain("unique-b");
    // raw "shared-model" should not be in the list
    expect(ids).not.toContain("shared-model");
  });

  it("uses explicit defaultModel when valid", () => {
    const mp = new MultiProvider({
      providers: [fakeDiscovery("X", ["a", "b", "c"])],
      defaultModel: "b",
    });
    expect(mp.defaultModel).toBe("b");
  });

  it("falls back to first model when defaultModel is invalid", () => {
    const mp = new MultiProvider({
      providers: [fakeDiscovery("X", ["a", "b"])],
      defaultModel: "nonexistent",
    });
    expect(mp.defaultModel).toBe("a");
  });

  it("skips providers with no models", () => {
    const mp = new MultiProvider({
      providers: [
        fakeDiscovery("Empty", []),
        fakeDiscovery("Good", ["gpt-4o"]),
      ],
    });
    expect(mp.availableModelIds).toEqual(["gpt-4o"]);
    expect(mp.defaultModel).toBe("gpt-4o");
  });
});
