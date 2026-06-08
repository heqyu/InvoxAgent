// 回归测试：Edit 工具不得把 CRLF 文件整体写成 LF
//
// Bug 复现路径：
//   1. 磁盘上一份 CRLF 文件
//   2. 通过 ACP readTextFile（编辑器侧）读出来时被归一化为 LF
//   3. LLM 给的 new_string 也是 LF
//   4. 替换得到的 newText 是纯 LF
//   5. 直接 writeTextFile / writeFileDirect 写回 → 整个文件 EOL 翻转
//
// 现象：git diff 显示几乎每一行都改了（+N -N），真实改动被淹没。
// 本文件用工作区外路径 + 真磁盘 fs 重现并锁住 Edit 的修复行为。

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectFileEol,
  toEol,
} from "../../src/tools/fs-utils.js";
import { editFileTool } from "../../src/tools/edit-file.js";
import { writeFileTool } from "../../src/tools/write-file.js";
import { FileCache } from "../../src/tools/cache.js";
import type { ToolExecContext } from "../../src/tools/types.js";

// ── 纯函数 helper ──────────────────────────────────────────────────────

describe("detectFileEol", () => {
  it("CRLF 文件被识别为 'crlf'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "a\r\nb\r\nc\r\n");
    expect(await detectFileEol(p)).toBe("crlf");
    rmSync(dir, { recursive: true, force: true });
  });

  it("LF 文件被识别为 'lf'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "a\nb\nc\n");
    expect(await detectFileEol(p)).toBe("lf");
    rmSync(dir, { recursive: true, force: true });
  });

  it("混合行尾被识别为 'mixed'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "a\r\nb\nc\r\n");
    expect(await detectFileEol(p)).toBe("mixed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("无换行返回 null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "no newlines here");
    expect(await detectFileEol(p)).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("不存在的文件返回 null（不抛异常）", async () => {
    expect(await detectFileEol(join(tmpdir(), "definitely-missing-XYZ"))).toBe(
      null,
    );
  });
});

describe("toEol", () => {
  it("LF → CRLF 幂等：纯 LF 输入正确转换", () => {
    expect(toEol("a\nb\nc", "crlf")).toBe("a\r\nb\r\nc");
  });

  it("CRLF → CRLF 幂等：不会出现 \\r\\r\\n", () => {
    expect(toEol("a\r\nb\r\nc", "crlf")).toBe("a\r\nb\r\nc");
  });

  it("混合行尾归一化为 CRLF", () => {
    expect(toEol("a\r\nb\nc\r\nd", "crlf")).toBe("a\r\nb\r\nc\r\nd");
  });

  it("CRLF → LF 移除所有 \\r", () => {
    expect(toEol("a\r\nb\r\n", "lf")).toBe("a\nb\n");
  });
});

// ── Edit 工具集成测试（CRLF 保留）──────────────────────────────────────
//
// 用工作区外目录避开 ACP 路径，让 Edit 走 writeFileDirect 真写磁盘。
// 这恰好就是 bug 在「跨工作区编辑」场景下的最小可复现配置；ACP 路径
// 同样使用 detectFileEol(path)，逻辑一致。

function makeCtx(cwd: string): ToolExecContext {
  return {
    // ACP 字段：工作区外不会被使用，给出最小占位
    conn: {} as never,
    sessionId: "test-session",
    cwd,
    caps: { fs: {} } as never,
    signal: new AbortController().signal,
    policy: "always",
    toolCallId: "test-tool",
    state: { readPaths: new Set<string>(), cache: new FileCache() },
  };
}

describe("editFileTool: CRLF 保留", () => {
  it("CRLF 文件被 Edit 后磁盘仍为 CRLF（仅改动行被替换）", async () => {
    // 用一个独立 tmp 目录作为「工作区外目标」+ 另一个目录作为「会话 cwd」，
    // 强制 isInsideWorkspace=false 走 writeFileDirect。
    const target = mkdtempSync(join(tmpdir(), "invox-edit-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-edit-cwd-"));
    const filePath = join(target, "demo.txt");

    const original = "alpha\r\nbeta\r\ngamma\r\ndelta\r\n";
    writeFileSync(filePath, original);
    expect(await detectFileEol(filePath)).toBe("crlf");

    const ctx = makeCtx(cwd);
    const res = await editFileTool.execute(
      {
        path: filePath,
        // LLM 给的 old_string / new_string 都是 LF —— 模拟真实场景。
        old_string: "beta",
        new_string: "BETA-CHANGED",
      },
      ctx,
    );

    expect(res.ok).toBe(true);

    // 关键断言：磁盘文件仍是 CRLF，未被整体翻转。
    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("alpha\r\nBETA-CHANGED\r\ngamma\r\ndelta\r\n");
    expect(await detectFileEol(filePath)).toBe("crlf");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("LF 文件被 Edit 后磁盘仍为 LF（不会被升级成 CRLF）", async () => {
    const target = mkdtempSync(join(tmpdir(), "invox-edit-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-edit-cwd-"));
    const filePath = join(target, "demo.txt");

    const original = "alpha\nbeta\ngamma\n";
    writeFileSync(filePath, original);
    expect(await detectFileEol(filePath)).toBe("lf");

    const ctx = makeCtx(cwd);
    const res = await editFileTool.execute(
      {
        path: filePath,
        old_string: "beta",
        new_string: "BETA",
      },
      ctx,
    );

    expect(res.ok).toBe(true);

    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("alpha\nBETA\ngamma\n");
    expect(await detectFileEol(filePath)).toBe("lf");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("new_string 内含多行（LF）写入 CRLF 文件时，新增行也用 CRLF", async () => {
    const target = mkdtempSync(join(tmpdir(), "invox-edit-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-edit-cwd-"));
    const filePath = join(target, "demo.txt");

    writeFileSync(filePath, "a\r\nb\r\nc\r\n");

    const ctx = makeCtx(cwd);
    const res = await editFileTool.execute(
      {
        path: filePath,
        old_string: "b",
        // LLM 输出的多行替换：内部用 LF
        new_string: "B1\nB2",
      },
      ctx,
    );

    expect(res.ok).toBe(true);

    // 全文必须是 CRLF；不能有「孤立 \n」。
    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("a\r\nB1\r\nB2\r\nc\r\n");
    // 全文不存在不带 \r 的孤立 \n
    expect(/[^\r]\n/.test(onDisk)).toBe(false);

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── Write 工具 EOL 行为 ─────────────────────────────────────────────────
//
// 语义分两档：
//   1. 覆盖已有 CRLF 文件 → 必须保持 CRLF（与 Edit 同样问题，避免 git
//      把整文件判定为变更）
//   2. 新建文件 → content 自决，不强制 CRLF（避免在纯 LF 仓库里"莫名"
//      生成 CRLF 文件）

describe("writeFileTool: 覆盖已有文件保留 EOL", () => {
  it("覆盖 CRLF 文件：磁盘仍为 CRLF（即便 LLM 给的 content 是 LF）", async () => {
    const target = mkdtempSync(join(tmpdir(), "invox-write-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-write-cwd-"));
    const filePath = join(target, "demo.txt");

    writeFileSync(filePath, "old1\r\nold2\r\nold3\r\n");
    expect(await detectFileEol(filePath)).toBe("crlf");

    const ctx = makeCtx(cwd);
    const res = await writeFileTool.execute(
      {
        path: filePath,
        // 模拟 LLM 整体覆盖：纯 LF
        content: "new1\nnew2\nnew3\n",
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("new1\r\nnew2\r\nnew3\r\n");
    expect(await detectFileEol(filePath)).toBe("crlf");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("覆盖 LF 文件：磁盘仍为 LF（不会被升级成 CRLF）", async () => {
    const target = mkdtempSync(join(tmpdir(), "invox-write-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-write-cwd-"));
    const filePath = join(target, "demo.txt");

    writeFileSync(filePath, "old1\nold2\n");

    const ctx = makeCtx(cwd);
    const res = await writeFileTool.execute(
      { path: filePath, content: "new1\nnew2\n" },
      ctx,
    );

    expect(res.ok).toBe(true);
    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("new1\nnew2\n");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("新建文件：不强制 EOL，content 自决（LF in → LF out）", async () => {
    const target = mkdtempSync(join(tmpdir(), "invox-write-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-write-cwd-"));
    const filePath = join(target, "brand-new.txt");

    const ctx = makeCtx(cwd);
    const res = await writeFileTool.execute(
      { path: filePath, content: "fresh\nfile\n" },
      ctx,
    );

    expect(res.ok).toBe(true);
    const onDisk = readFileSync(filePath, "utf-8");
    expect(onDisk).toBe("fresh\nfile\n");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});
