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
  detectEolInfo,
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

describe("detectEolInfo (含主导风格)", () => {
  it("CRLF 主导：mixed 文件中 CRLF 多 → dominant=crlf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    // 5 行 CRLF + 1 行 LF
    writeFileSync(p, "a\r\nb\r\nc\r\nd\r\ne\nf\r\n");
    const info = await detectEolInfo(p);
    expect(info).not.toBeNull();
    expect(info!.style).toBe("mixed");
    expect(info!.dominant).toBe("crlf");
    expect(info!.crlfCount).toBe(5);
    expect(info!.lfCount).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("LF 主导：mixed 文件中 LF 多 → dominant=lf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "a\nb\nc\r\nd\ne\n");
    const info = await detectEolInfo(p);
    expect(info!.style).toBe("mixed");
    expect(info!.dominant).toBe("lf");
    rmSync(dir, { recursive: true, force: true });
  });

  it("平手时偏向 CRLF（Windows 场景下 mixed 几乎都是 CRLF 受损）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invox-eol-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "a\r\nb\n");
    const info = await detectEolInfo(p);
    expect(info!.crlfCount).toBe(info!.lfCount);
    expect(info!.dominant).toBe("crlf");
    rmSync(dir, { recursive: true, force: true });
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

  it("mixed 文件（CRLF 主导）被 Edit 后整文件归一化为 CRLF", async () => {
    // 这是最关键的回归用例：
    // 现实场景里，文件之前可能因为旧版 Edit/Write 的 bug 已经被弄成 mixed
    // —— 例如 200 行 CRLF + 中间 6 行 LF。本次 Edit 必须把整文件复原为
    // CRLF，否则 git diff 仍会显示那些"残留 LF 行"为变更。
    const target = mkdtempSync(join(tmpdir(), "invox-edit-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-edit-cwd-"));
    const filePath = join(target, "scarred.txt");

    // 大部分 CRLF + 中间几行孤立 LF（模拟旧 bug 留下的伤疤）
    writeFileSync(
      filePath,
      "h1\r\nh2\r\nh3\r\nbroken1\nbroken2\nbroken3\nt1\r\nt2\r\n",
    );
    const before = await detectEolInfo(filePath);
    expect(before!.style).toBe("mixed");
    expect(before!.dominant).toBe("crlf");

    const ctx = makeCtx(cwd);
    const res = await editFileTool.execute(
      {
        path: filePath,
        old_string: "h2",
        new_string: "H2",
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    const onDisk = readFileSync(filePath, "utf-8");
    // 全文 CRLF：包括原来"受损"的 broken1/2/3 行
    expect(onDisk).toBe(
      "h1\r\nH2\r\nh3\r\nbroken1\r\nbroken2\r\nbroken3\r\nt1\r\nt2\r\n",
    );
    expect(/[^\r]\n/.test(onDisk)).toBe(false);
    expect((await detectEolInfo(filePath))!.style).toBe("crlf");

    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("以磁盘原文为基底：cache 被污染（如 buffer 被 autoformat）也不影响 git diff", async () => {
    // 模拟真实事故：编辑器（Zed）的 ACP buffer 被 lua autoformatter 修改，
    // 通过 readFileWithCache 读到的是被污染版（end 顶到行首、tab→spaces）；
    // 但磁盘原文是干净的。Edit 必须以磁盘为替换基底，确保未触碰的行
    // 字节级保持原样。
    const target = mkdtempSync(join(tmpdir(), "invox-edit-target-"));
    const cwd = mkdtempSync(join(tmpdir(), "invox-edit-cwd-"));
    const filePath = join(target, "lua.lua");

    // 磁盘原文：lua 风格，end 有 4 空格缩进，行末有 trailing spaces
    const onDiskOriginal =
      "function foo()\r\n" +
      "    if x then   \r\n" + // trailing whitespace（Zed 容易剥）
      "        bar()\r\n" +
      "    end\r\n" + // 4 空格缩进
      "end\r\n";
    writeFileSync(filePath, onDiskOriginal);

    const ctx = makeCtx(cwd);
    // 主动往 cache 里塞一份「被 autoformat 污染过」的版本：
    //   - end 顶到行首
    //   - trailing whitespace 被剥
    //   - 行尾归一化为 LF
    const polluted =
      "function foo()\n" +
      "    if x then\n" + // 没了 trailing spaces
      "        bar()\n" +
      "end\n" + // end 缩进被吞掉
      "end\n";
    ctx.state.cache.set(filePath, polluted);
    ctx.state.readPaths.add(filePath);

    // LLM 想把 bar() 改成 baz()
    const res = await editFileTool.execute(
      {
        path: filePath,
        old_string: "bar()",
        new_string: "baz()",
      },
      ctx,
    );

    expect(res.ok).toBe(true);

    // 关键断言：磁盘上除了 bar→baz 这一处，其他每一个字节都和原文相同。
    // 即 trailing spaces / end 缩进 / CRLF 全部保留，git diff 应只显示 1 行。
    const onDisk = readFileSync(filePath, "utf-8");
    const expected = onDiskOriginal.replace("bar()", "baz()");
    expect(onDisk).toBe(expected);

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
