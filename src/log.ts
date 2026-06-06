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
// 模块过滤由环境变量 INVOX_LOG_MODULE 控制：
//   "*"          → 全部通过（默认）
//   "" / "[]"    → 全部静默
//   "aa,bb"      → 仅 aa、bb 通过
//   "*,-aa,-bb"  → 除了 aa、bb 都通过
//
// 时间戳：默认本地 "MM-DD HH:mm:ss.SSS"（人眼对照实际操作易读）；
// INVOX_LOG_UTC=1 切回 ISO UTC 格式以便日志聚合。

import { closeSync, createWriteStream, mkdirSync, openSync, writeSync, type WriteStream } from "node:fs";
import { join } from "node:path";

type Level = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export interface Logger {
  error: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  info: (msg: string, ...rest: unknown[]) => void;
  debug: (msg: string, ...rest: unknown[]) => void;
  trace: (msg: string, ...rest: unknown[]) => void;
  /** 当前等级+模块是否会输出指定级别。用来跳过昂贵 payload 准备。 */
  isEnabled: (level: Exclude<Level, "silent">) => boolean;
}

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

// ── Module filtering ─────────────────────────────────────────────────

type ModuleFilter = (mod: string) => boolean;

function parseModuleFilter(raw: string | undefined): ModuleFilter {
  if (raw === undefined || raw === "*") {
    // 未设置或 "*" → 全部通过
    return () => true;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]") {
    // 空或 "[]" → 全部静默
    return () => false;
  }
  // 按逗号拆分，处理 "*,-aa,-bb" 与 "aa,bb" 两种语法
  const parts = trimmed.split(",").map((s) => s.trim());
  const whitelist: string[] = [];
  const blacklist: string[] = [];
  let hasWildcard = false;
  for (const part of parts) {
    if (part.startsWith("-")) {
      blacklist.push(part.slice(1));
    } else if (part === "*") {
      hasWildcard = true;
    } else {
      whitelist.push(part);
    }
  }
  // 通配符模式：默认通过，黑名单中的排除
  if (hasWildcard) {
    return (mod: string) => !blacklist.includes(mod);
  }
  // 纯白名单
  if (whitelist.length > 0) {
    return (mod: string) => whitelist.includes(mod);
  }
  // 只有黑名单（无 *），等价于 "*,-xxx"
  return (mod: string) => !blacklist.includes(mod);
}

/** 每次调用时读 env，与 currentLevel() 保持一致的惰性策略。 */
function currentModuleFilter(): ModuleFilter {
  return parseModuleFilter(process.env["INVOX_LOG_MODULE"]);
}

// ── File stream ──────────────────────────────────────────────────────

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
    fileStream.write(
      `\n--- invox started @ ${formatTimestamp(new Date())} pid=${process.pid} ---\n`,
    );
    return fileStream;
  } catch (err) {
    process.stderr.write(
      `[log] cannot open ${path}: ${(err as Error).message}\n`,
    );
    return null;
  }
}

// ── Formatting ───────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
function pad3(n: number): string {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}

export function formatTimestamp(d: Date): string {
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

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Emit (internal) ──────────────────────────────────────────────────

function emit(
  level: Exclude<Level, "silent">,
  moduleName: string,
  msg: string,
  ...rest: unknown[]
): void {
  if (RANK[currentLevel()] < RANK[level]) return;
  if (!currentModuleFilter()(moduleName)) return;
  const ts = formatTimestamp(new Date());
  const line =
    rest.length > 0
      ? `${ts} [${level}] [${moduleName}] ${msg} ${rest.map((r) => safeStringify(r)).join(" ")}\n`
      : `${ts} [${level}] [${moduleName}] ${msg}\n`;
  process.stderr.write(line);
  const fs = getFileStream();
  if (fs) fs.write(line);
}

// ── createLogger ─────────────────────────────────────────────────────

/**
 * 创建带模块标识的 logger。
 * @param moduleName 模块名称，如 "agent"、"llm"、"tools" 等
 * @returns Logger 对象，方法签名与旧版 log 兼容
 */
export function createLogger(moduleName: string): Logger {
  return {
    error: (msg, ...rest) => emit("error", moduleName, msg, ...rest),
    warn: (msg, ...rest) => emit("warn", moduleName, msg, ...rest),
    info: (msg, ...rest) => emit("info", moduleName, msg, ...rest),
    debug: (msg, ...rest) => emit("debug", moduleName, msg, ...rest),
    trace: (msg, ...rest) => emit("trace", moduleName, msg, ...rest),
    isEnabled(level) {
      return (
        RANK[currentLevel()] >= RANK[level] && currentModuleFilter()(moduleName)
      );
    },
  };
}

// ── 默认导出（向后兼容）─────────────────────────────────────────────

// ── 会话日志文件（共享给主 agent 与 subagent 使用）───────────────────────

/**
 * 同步追加写入的日志文件句柄。
 *
 * 设计要点（与 subagent 日志同款）：
 *   - **同步写**（openSync / writeSync / closeSync）：事件密度不高时，
 *     同步写换来"返回时文件一定可见"的强保证
 *   - **失败容错**：mkdir / openSync 失败时返回 noop，不让日志故障拖崩主流程
 *   - **并发安全**：每个 session / subagent 各自持有独立 fd，互不冲突
 */
export interface LogFile {
  /** 文件绝对路径；noop 日志的 path=""。 */
  path: string;
  /** 追加一行（自动补换行）。 */
  write(line: string): void;
  /** 关闭 fd。幂等。 */
  close(): void;
}

/** noop 日志兜底 —— 开文件失败时返回全空操作。 */
const noopLog: LogFile = {
  path: "",
  write: () => {},
  close: () => {},
};

/**
 * 打开一个按 session（或 subagent）隔离的日志文件。
 *
 *   - 路径：`<cwd>/.invox/logs/<filename>.log`
 *   - 自动建目录：`.invox/logs/` 不存在时自动递归创建
 *   - 写入前不会进 INVOX_LOG_FILE（那是全局文件），是独立文件
 *   - mkdir / openSync 失败 → warn 一条主日志 + 返回 noop
 *
 * @param cwd    工作区根目录
 * @param name   日志文件名的核心部分（不含路径和 .log 后缀），如 sessionId
 * @param label  日志中标记标签，如 "session" / "subagent"
 */
export function openSessionLogFile(
  cwd: string,
  name: string,
  label: string,
): LogFile {
  const dir = join(cwd, ".invox", "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // 用 process.stderr 而非 log.warn（避免递归）
    process.stderr.write(
      `[log] ${label} log: cannot mkdir ${dir}: ${(e as Error).message}\n`,
    );
    return noopLog;
  }

  // sanitize：sessionId 或其它传入的 name 可能含特殊字符
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(dir, `${safeName}.log`);

  let fd: number;
  try {
    fd = openSync(filePath, "a");
  } catch (e) {
    process.stderr.write(
      `[log] ${label} log: cannot open ${filePath}: ${(e as Error).message}\n`,
    );
    return noopLog;
  }

  let closed = false;
  return {
    path: filePath,
    write: (line: string) => {
      if (closed) return;
      try {
        writeSync(fd, line.endsWith("\n") ? line : line + "\n");
      } catch {
        // 写失败静默
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // 已关闭 / 未打开都视为 no-op
      }
    },
  };
}

/**
 * 把任意文本截到 max 字符内，溢出加省略号 + 长度提示。
 * 替换换行为 \n 转义，一行一个条目方便 grep。
 */
export function preview(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, "\\n");
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + `…(+${oneLine.length - max} chars)`;
}

/** 默认 logger，模块标识为 "core"。保留用于 log.ts 内部日志等场景。 */
export const log: Logger = createLogger("core");
