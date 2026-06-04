// log：写 stderr + 可选写文件。stdout 在 stdio transport 上专用于
// JSON-RPC 帧，这里所有日志一律走 fd 2。
// 设置 INVOX_LOG_FILE 后会同时追加到该文件 —— Zed 启动时 stderr 不易看见，
// 落盘日志方便排查。
//
// 等级由环境变量 INVOX_LOG 控制：
//   "silent" | "error" | "warn" | "info" | "debug" | "trace"
// 默认 "info"。trace 会 dump 完整 LLM payload —— 生产环境严禁开启，
// prompt / 工具输出可能含密钥等敏感数据。
//
// 时间戳：默认本地 "MM-DD HH:mm:ss.SSS"（人眼对照实际操作易读）；
// INVOX_LOG_UTC=1 切回 ISO UTC 格式以便日志聚合。

import { createWriteStream, type WriteStream } from "node:fs";

type Level = "silent" | "error" | "warn" | "info" | "debug" | "trace";

const RANK: Record<Level, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

function currentLevel(): Level {
  const raw = (process.env["INVOX_LOG"] ?? "info").toLowerCase() as Level;
  return raw in RANK ? raw : "info";
}

let fileStream: WriteStream | null = null;
let fileStreamTried = false;

function getFileStream(): WriteStream | null {
  if (fileStreamTried) return fileStream;
  fileStreamTried = true;
  const path = process.env["INVOX_LOG_FILE"];
  if (!path) return null;
  try {
    fileStream = createWriteStream(path, { flags: "a" });
    fileStream.on("error", (err) => {
      // 不递归调 log.error —— 直接写 stderr，避免循环。
      process.stderr.write(`[log] file stream error: ${err.message}\n`);
    });
    // 启动标记，方便区分每次 invox 会话的开始位置。
    fileStream.write(`\n--- invox started @ ${formatTimestamp(new Date())} pid=${process.pid} ---\n`);
    return fileStream;
  } catch (err) {
    process.stderr.write(`[log] cannot open ${path}: ${(err as Error).message}\n`);
    return null;
  }
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
function pad3(n: number): string {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}

function formatTimestamp(d: Date): string {
  if (process.env["INVOX_LOG_UTC"] === "1") return d.toISOString();
  // 本地时间 "MM-DD HH:mm:ss.SSS" —— 短而无歧义。
  return (
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds()) +
    "." +
    pad3(d.getMilliseconds())
  );
}

function emit(level: Exclude<Level, "silent">, msg: string, ...rest: unknown[]): void {
  if (RANK[currentLevel()] < RANK[level]) return;
  const ts = formatTimestamp(new Date());
  const line =
    rest.length > 0
      ? `${ts} [${level}] ${msg} ${rest.map((r) => safeStringify(r)).join(" ")}\n`
      : `${ts} [${level}] ${msg}\n`;
  process.stderr.write(line);
  const fs = getFileStream();
  if (fs) fs.write(line);
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  error: (msg: string, ...rest: unknown[]): void => emit("error", msg, ...rest),
  warn: (msg: string, ...rest: unknown[]): void => emit("warn", msg, ...rest),
  info: (msg: string, ...rest: unknown[]): void => emit("info", msg, ...rest),
  debug: (msg: string, ...rest: unknown[]): void => emit("debug", msg, ...rest),
  trace: (msg: string, ...rest: unknown[]): void => emit("trace", msg, ...rest),
  /** 当前等级是否会输出指定级别。用来跳过昂贵 payload 准备。 */
  isEnabled(level: Exclude<Level, "silent">): boolean {
    return RANK[currentLevel()] >= RANK[level];
  },
};
