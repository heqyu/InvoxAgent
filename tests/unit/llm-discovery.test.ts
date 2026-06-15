import { describe, it, expect } from "vitest";
import { discoverModels, type ProviderConfig } from "../../src/llm/discovery.js";

describe("llm/discovery", () => {
  it("returns empty models with error for unreachable provider", async () => {
    const config: ProviderConfig = {
      name: "test-unreachable",
      baseUrl: "http://localhost:19999/v1",
      apiKey: "test-key",
    };
    const result = await discoverModels(config);
    expect(result.providerName).toBe("test-unreachable");
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it("returns empty models for 404 response", async () => {
    const config: ProviderConfig = {
      name: "test-404",
      baseUrl: "https://httpbin.org/status/404",
      apiKey: "test-key",
    };
    const result = await discoverModels(config);
    expect(result.providerName).toBe("test-404");
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });
});
