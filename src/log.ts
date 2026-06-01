// Stderr + optional file logger. stdout is reserved for JSON-RPC framing on the
// stdio transport (see PLAN.md §3 — first pitfall). All logs go to fd 2 unconditionally.
// If INVOX_LOG_FILE is set, the same lines are also appended to that file —
// useful when launched from Zed where stderr is hard to surface.
//
// Levels gated by env var INVOX_LOG: "silent" | "error" | "warn" | "info" | "debug" | "trace".
// Default: "info".  At "trace" we also dump full LLM payloads — DO NOT use
// trace in production since prompts and tool outputs may contain secrets.
//
// Timestamps:
//   default: local time MM-DD HH:mm:ss.SSS — easy on the eye when you're
//   correlating with a real-world action.
//   INVOX_LOG_UTC=1 falls back to ISO UTC (older format) for log shipping.

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
      // Don't recurse through log.error — write directly to stderr.
      process.stderr.write(`[log] file stream error: ${err.message}\n`);
    });
    // Boot marker so it's obvious where each invox session begins.
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
  // Local time, "MM-DD HH:mm:ss.SSS" — short enough to keep room for the
  // payload, unambiguous within a day.
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
  /** Returns true iff at least the given level would be emitted. Use to skip
   * expensive payload preparation when nobody's listening. */
  isEnabled(level: Exclude<Level, "silent">): boolean {
    return RANK[currentLevel()] >= RANK[level];
  },
};
