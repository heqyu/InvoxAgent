// Transport 抽象 —— 让 stdio / WebSocket 共用 cli.ts 的接入逻辑。
//
// 每个 transport 负责：
//   - 接受对端连接（stdio: 1 个；ws: N 个）
//   - 为每个对端产出一个消息流
//   - 通过 onPeer 回调把流交给上层
//   - stop() 时清理资源
//
// 统一用 onPeer(stream) 的形式，是为了让"单对端 (stdio)"和"多对端 (ws)"
// 走同一段接入代码。

import type { Stream } from "@agentclientprotocol/sdk";

export interface Transport {
  readonly name: "stdio" | "ws";
  /** 启动监听；每来一个对端就调用一次 onPeer。 */
  start(onPeer: (peer: Stream) => void | Promise<void>): Promise<void>;
  /** 停止监听并释放资源。 */
  stop(): Promise<void>;
}
