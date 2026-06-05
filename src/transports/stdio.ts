// stdio transport：把 process.stdin/stdout 包装成 ACP 需要的 Web Streams。
//
// 终生只服务一个对端（启动 invox 的客户端，比如 Zed）。
// stop() 是 no-op —— 关 stdin 是客户端的事，我们不持有底层 fd。
//
// 设计选择：用 Node 18+ 的 Readable.toWeb / Writable.toWeb，直接得到
// ndJsonStream 需要的 ReadableStream<Uint8Array>，避免手写字节泵和分片 bug。

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { createLogger } from "../log.js";
const log = createLogger("transport");
import type { Transport } from "./types.js";

export class StdioTransport implements Transport {
  readonly name = "stdio" as const;

  async start(onPeer: (peer: Stream) => void | Promise<void>): Promise<void> {
    const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);
    log.info("stdio transport: ready");
    await onPeer(stream);
  }

  async stop(): Promise<void> {
    // 不持有底层 fd，无需解绑。
  }
}
