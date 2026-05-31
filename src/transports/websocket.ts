// WebSocket transport. Each WS connection = one ACP peer = one InvoxAgent.
//
// Frame format (documented in README):
//   - Each WebSocket text message is exactly one JSON-RPC 2.0 envelope
//     (request, response, or notification).
//   - No NDJSON delimiter — WebSocket already provides message framing.
//
// CHOICE: per-message-mapped Stream<AnyMessage> directly, NOT bytes through
// ndJsonStream. Reasons:
//   - WS already frames messages → an extra newline-delimited byte layer
//     would be wasteful and bug-prone (PLAN §3 "sharing a parser across
//     transports" pitfall).
//   - The ACP package's `Stream` type is `WritableStream<AnyMessage>` /
//     `ReadableStream<AnyMessage>` — going message-typed avoids round-tripping
//     through bytes.
//
// Multi-client: the same agent process can serve N concurrent WS clients;
// each gets its own InvoxAgent instance via the cli.ts `onPeer` callback.

import { WebSocketServer, type WebSocket } from "ws";
import type { AnyMessage, Stream } from "@zed-industries/agent-client-protocol";
import { log } from "../log.js";
import type { Transport } from "./types.js";

export interface WebSocketTransportConfig {
  host: string;
  port: number;
}

export class WebSocketTransport implements Transport {
  readonly name = "ws" as const;
  private wss?: WebSocketServer;
  private cfg: WebSocketTransportConfig;

  constructor(cfg: WebSocketTransportConfig) {
    this.cfg = cfg;
  }

  async start(onPeer: (peer: Stream) => void | Promise<void>): Promise<void> {
    const wss = new WebSocketServer({ host: this.cfg.host, port: this.cfg.port });
    this.wss = wss;

    await new Promise<void>((resolve, reject) => {
      const onListen = (): void => {
        wss.off("error", onErr);
        log.info(`ws transport: listening on ${this.cfg.host}:${this.cfg.port}`);
        resolve();
      };
      const onErr = (err: Error): void => {
        wss.off("listening", onListen);
        reject(err);
      };
      wss.once("listening", onListen);
      wss.once("error", onErr);
    });

    wss.on("connection", (socket, req) => {
      const remote = req.socket.remoteAddress ?? "?";
      log.info("ws: client connected", { remote });
      const peer = wsToStream(socket);
      Promise.resolve(onPeer(peer)).catch((err: unknown) => {
        log.error("ws: onPeer failed", err instanceof Error ? err.message : String(err));
        socket.close(1011, "internal error");
      });
    });

    wss.on("error", (err) => {
      log.error("ws server error", err.message);
    });
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    const wss = this.wss;
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    log.info("ws transport: closed");
  }
}

/**
 * Bridge a single WebSocket connection into the ACP message Stream contract.
 * One inbound WS message → one AnyMessage. One outbound AnyMessage → one
 * WS message. No batching, no buffering beyond the OS socket.
 */
function wsToStream(socket: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      socket.on("message", (data) => {
        try {
          const text = typeof data === "string" ? data : data.toString("utf8");
          const msg = JSON.parse(text) as AnyMessage;
          controller.enqueue(msg);
        } catch (err) {
          log.warn("ws: dropping malformed JSON frame", String(err));
          // Don't error the controller — one bad frame shouldn't kill the
          // whole connection. The peer can recover by sending valid frames.
        }
      });
      socket.on("close", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      socket.on("error", (err) => {
        log.warn("ws: socket error", err.message);
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      return new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify(msg), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      try {
        socket.close(1000, "agent closed stream");
      } catch {
        // already closed
      }
    },
    abort() {
      try {
        socket.terminate();
      } catch {
        // already closed
      }
    },
  });

  return { readable, writable };
}
