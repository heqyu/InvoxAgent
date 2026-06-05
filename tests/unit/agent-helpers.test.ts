// agent-helpers.ts 的单元测试
//
// 重点验证 K12 修复：agentVersion() 在 dev 模式下能从 src/agent/agent-helpers.ts
// 正确上溯两级到仓库根目录读到 package.json，不再返回 "unknown"。
// （tests 自身就跑在 dev 模式下，src 树未编译。）

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentVersion, maxIterations } from "../../src/agent/agent-helpers.js";

describe("agent-helpers", () => {
  describe("agentVersion()", () => {
    it("returns the version from repo package.json (not 'unknown')", () => {
      // 测试自身位于 tests/unit/，向上两级才到 root；与 K12 修复无关，
      // 我们只想读 root/package.json 的真值用作期望对比。
      const here = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(here, "..", "..");
      const pkgVersion = (
        JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;

      const got = agentVersion();
      expect(got).toBe(pkgVersion);
      expect(got).not.toBe("unknown");
    });

    it("is memoised across calls", () => {
      // 第二次调用走缓存分支；只要不抛 + 等于第一次返回值即可。
      const first = agentVersion();
      const second = agentVersion();
      expect(second).toBe(first);
    });
  });

  describe("maxIterations()", () => {
    const ENV_KEY = "INVOX_MAX_ITERATIONS";
    const original = process.env[ENV_KEY];

    function withEnv(value: string | undefined, fn: () => void): void {
      if (value === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = value;
      try {
        fn();
      } finally {
        if (original === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = original;
      }
    }

    it("defaults to 50 when env var is unset", () => {
      withEnv(undefined, () => {
        expect(maxIterations()).toBe(50);
      });
    });

    it("respects a positive integer", () => {
      withEnv("12", () => {
        expect(maxIterations()).toBe(12);
      });
    });

    it("falls back to 50 for non-numeric / non-positive input", () => {
      withEnv("abc", () => {
        expect(maxIterations()).toBe(50);
      });
      withEnv("0", () => {
        expect(maxIterations()).toBe(50);
      });
      withEnv("-7", () => {
        expect(maxIterations()).toBe(50);
      });
    });
  });
});
