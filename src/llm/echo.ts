// EchoProvider —— 不联网的确定性 LLM stub，供离线开发 / smoke test 使用。
//
// 行为：把最后一条 user 消息原样回声回去，按 8 字符分片以模拟流式输出。
// 输出格式与 stage 1 保持一致，避免破坏既有 smoke 断言。

import type { LLMDelta, LLMProvider, LLMRequest } from "./types.js";
import { chunkString, contentToString, sleep } from "./utils.js";

export class EchoProvider implements LLMProvider {
  readonly name = "echo";

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = contentToString(lastUser?.content);
    const reply = `invox echo: you said "${text}". streaming works ✓`;
    for (const piece of chunkString(reply, 8)) {
      if (req.signal.aborted) return;
      yield { kind: "text", text: piece };
      await sleep(20);
    }
  }
}
