// Stdio transport. Wraps process.stdin / process.stdout as Web Streams of bytes,
// then hands them to ACP's `ndJsonStream` which produces a typed message Stream.
//
// One peer ever (the launching client) — Zed, in normal use.
// `start` invokes `onPeer` once and resolves. `stop` is a no-op for stdio
// because there's nothing to unbind — closing stdin is the client's job.
//
// CHOICE: `Readable.toWeb` / `Writable.toWeb` from node:stream. Native to Node 18+,
// produces the exact `ReadableStream<Uint8Array>` / `WritableStream<Uint8Array>`
// that `ndJsonStream` consumes. No manual byte-pump loop, no chunk-boundary bugs.

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { log } from "../log.js";
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
    // Nothing to unbind: we don't own the underlying fd.
  }
}
