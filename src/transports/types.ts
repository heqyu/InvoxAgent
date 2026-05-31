// Transport contract — the abstraction that lets stdio/ws coexist (PLAN.md §1).
//
// CHOICE: each transport produces a `Stream` consumable by the ACP package
// (typed `WritableStream<AnyMessage>`/`ReadableStream<AnyMessage>` after `ndJsonStream`
// wrapping for byte-oriented transports, OR a direct message stream for
// WebSocket where messages arrive pre-framed).
//
// The transport is responsible for:
//   - accepting peer connections (1 for stdio, N for ws)
//   - producing a message stream per peer
//   - calling `onPeer(stream)` when a peer arrives
//   - cleaning up on stop()
//
// Why not "one transport returns one stream and we loop": stdio has exactly
// one peer (the launching client), but ws has 0..N. The `onPeer` callback
// is the unified shape that handles both.

import type { Stream } from "@zed-industries/agent-client-protocol";

export interface Transport {
  readonly name: "stdio" | "ws";
  start(onPeer: (peer: Stream) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
