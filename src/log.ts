// Stderr + optional file logger. stdout is reserved for JSON-RPC framing on the
// stdio transport (see PLAN.md §3 — first pitfall). All logs go to fd 2 unconditionally.
// If INVOX_LOG_FILE is set, the same lines are also appended to that file —
// useful when launched from Zed where stderr is hard to surface.
//
// Levels gated by env var INVOX_LOG: "silent" | "error" | "warn" | "info" | "debug".
// Default: "info".

import { createWriteStream, type WriteStream } from "node:fs";

type Level = "silent" | "error" | "warn" | "info" | "debug";

const RANK: Record<Level, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
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
    fileStream.write(`\n--- invox started @ ${new Date().toISOString()} pid=${process.pid} ---\n`);
    return fileStream;
  } catch (err) {
    process.stderr.write(`[log] cannot open ${path}: ${(err as Error).message}\n`);
    return null;
  }
}

function emit(level: Exclude<Level, "silent">, msg: string, ...rest: unknown[]): void {
  if (RANK[currentLevel()] < RANK[level]) return;
  const ts = new Date().toISOString();
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
};
