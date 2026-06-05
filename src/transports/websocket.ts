// WebSocket transport：每个 WS 连接 = 一个 ACP peer = 一个 InvoxAgent。
//
// 帧格式（README 文档化）：
//   - 每条 WebSocket 文本消息恰好是一份 JSON-RPC 2.0 信封（请求 / 响应 / 通知）。
//   - 不用 NDJSON 分隔符 —— WebSocket 自身已经提供消息分帧。
//
// 设计选择：直接 per-message 映射 Stream<AnyMessage>，不走 ndJsonStream。
//   - WS 已经分帧，再加一层 newline-delimited 字节既浪费又容易踩坑
//   - SDK 的 Stream 类型本身就是 WritableStream<AnyMessage> /
//     ReadableStream<AnyMessage>，走 message-typed 避免 round-trip 字节
//
// 多客户端：同一进程可同时服务 N 个 WS client，每个通过 cli.ts 的 onPeer
// 回调拿到独立的 InvoxAgent 实例。

import { WebSocketServer, type WebSocket } from "ws";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { createLogger } from "../log.js";
const log = createLogger("transport");
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
    const wss = new WebSocketServer({
      host: this.cfg.host,
      port: this.cfg.port,
    });
    this.wss = wss;

    await new Promise<void>((resolve, reject) => {
      const onListen = (): void => {
        wss.off("error", onErr);
        log.info(
          `ws transport: listening on ${this.cfg.host}:${this.cfg.port}`,
        );
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
        log.error(
          "ws: onPeer failed",
          err instanceof Error ? err.message : String(err),
        );
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
 * 把单个 WS 连接桥接成 ACP 的消息 Stream 契约：
 * 一条 WS 入站消息 → 一个 AnyMessage；一个出站 AnyMessage → 一条 WS 消息。
 * 不做批量缓冲，仅依赖底层 socket buffer。
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
          // 不让 controller 报错 —— 单帧问题不应弄死整个连接，对端发后续合法帧仍能恢复。
        }
      });
      socket.on("close", () => {
        try {
          controller.close();
        } catch {
          // 已经 close
        }
      });
      socket.on("error", (err) => {
        log.warn("ws: socket error", err.message);
        try {
          controller.error(err);
        } catch {
          // 已经 close
        }
      });
    },
    cancel() {
      try {
        socket.close();
      } catch {
        // 已经 close
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
        // 已经 close
      }
    },
    abort() {
      try {
        socket.terminate();
      } catch {
        // 已经 close
      }
    },
  });

  return { readable, writable };
}
