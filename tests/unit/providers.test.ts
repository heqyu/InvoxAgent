import { describe, it, expect } from "vitest";

import { loadProvidersJson } from "../src/llm/providers.js";

describe("providers", () => {
  describe("loadProvidersJson", () => {
    it("returns null for non-existent path", () => {
      expect(loadProvidersJson("/nonexistent/path")).toBeNull();
    });
  });
});
