import { describe, it, expect } from "vitest";
import { resolveEnvRef } from "../src/llm/providers.js";

// resolveEnvRef is not exported directly — test through loadProvidersJson
// and loadProviderFromEnv. But we can test the exported functions directly.

import {
  loadProvidersJson,
  loadProviderFromEnv,
  type ProviderConfig,
} from "../src/llm/providers.js";

describe("providers", () => {
  describe("loadProviderFromEnv", () => {
    it("returns null when INVOX_API_KEY is missing", () => {
      const saved = { apiKey: process.env["INVOX_API_KEY"], baseUrl: process.env["INVOX_BASE_URL"], model: process.env["INVOX_MODEL"] };
      delete process.env["INVOX_API_KEY"];
      delete process.env["INVOX_BASE_URL"];
      try {
        expect(loadProviderFromEnv()).toBeNull();
      } finally {
        if (saved.apiKey) process.env["INVOX_API_KEY"] = saved.apiKey;
        if (saved.baseUrl) process.env["INVOX_BASE_URL"] = saved.baseUrl;
        if (saved.model) process.env["INVOX_MODEL"] = saved.model;
      }
    });

    it("returns null when INVOX_BASE_URL is missing", () => {
      const saved = { apiKey: process.env["INVOX_API_KEY"], baseUrl: process.env["INVOX_BASE_URL"] };
      process.env["INVOX_API_KEY"] = "test-key";
      delete process.env["INVOX_BASE_URL"];
      try {
        expect(loadProviderFromEnv()).toBeNull();
      } finally {
        if (saved.apiKey) process.env["INVOX_API_KEY"] = saved.apiKey; else delete process.env["INVOX_API_KEY"];
        if (saved.baseUrl) process.env["INVOX_BASE_URL"] = saved.baseUrl; else delete process.env["INVOX_BASE_URL"];
      }
    });

    it("returns provider config when both env vars are set", () => {
      const saved = { apiKey: process.env["INVOX_API_KEY"], baseUrl: process.env["INVOX_BASE_URL"], model: process.env["INVOX_MODEL"] };
      process.env["INVOX_API_KEY"] = "test-key";
      process.env["INVOX_BASE_URL"] = "https://api.example.com/v1";
      process.env["INVOX_MODEL"] = "gpt-4o";
      try {
        const config = loadProviderFromEnv();
        expect(config).not.toBeNull();
        expect(config!.name).toBe("default");
        expect(config!.baseUrl).toBe("https://api.example.com/v1");
        expect(config!.apiKey).toBe("test-key");
        expect(config!.models).toEqual(["gpt-4o"]);
      } finally {
        if (saved.apiKey) process.env["INVOX_API_KEY"] = saved.apiKey; else delete process.env["INVOX_API_KEY"];
        if (saved.baseUrl) process.env["INVOX_BASE_URL"] = saved.baseUrl; else delete process.env["INVOX_BASE_URL"];
        if (saved.model) process.env["INVOX_MODEL"] = saved.model; else delete process.env["INVOX_MODEL"];
      }
    });

    it("strips trailing slashes from baseUrl", () => {
      const saved = { apiKey: process.env["INVOX_API_KEY"], baseUrl: process.env["INVOX_BASE_URL"] };
      process.env["INVOX_API_KEY"] = "k";
      process.env["INVOX_BASE_URL"] = "https://api.example.com/v1///";
      try {
        const config = loadProviderFromEnv();
        expect(config!.baseUrl).toBe("https://api.example.com/v1");
      } finally {
        if (saved.apiKey) process.env["INVOX_API_KEY"] = saved.apiKey; else delete process.env["INVOX_API_KEY"];
        if (saved.baseUrl) process.env["INVOX_BASE_URL"] = saved.baseUrl; else delete process.env["INVOX_BASE_URL"];
      }
    });
  });

  describe("loadProvidersJson", () => {
    it("returns null for non-existent path", () => {
      expect(loadProvidersJson("/nonexistent/path")).toBeNull();
    });
  });
});
