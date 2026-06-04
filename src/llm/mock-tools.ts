// MockToolProvider —— 离线跑 tool-calling 流程的确定性 stub。
//
// 流程：
//   - 第 1 轮：扫 user 消息找路径（"read X" 或 "X" 引号），emit 一个
//     Read tool_call。
//   - 第 2 轮（agent 把 Read 结果回灌为 tool message 后）：emit text
//     deltas 总结字节数 + finish。
//
// smoke-tools.ts 借此断言整条链路 LLM→tool→LLM→user，无需 LLM 凭据。

import type {
  LLMDelta,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  ParsedToolCall,
} from "./types.js";
import { chunkString, contentToString, sleep } from "./utils.js";

export class MockToolProvider implements LLMProvider {
  readonly name = "mock-tools";
  private callCounter = 0;

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const lastIsTool = req.messages.at(-1)?.role === "tool";

    if (!lastIsTool) {
      // 第 1 阶段：emit Read tool_call。
      const userMsg = lastUserContent(req.messages);
      const path = extractPath(userMsg) ?? "package.json";
      this.callCounter += 1;
      const id = `mock_${this.callCounter}`;
      // 先吐一句"思考"，再吐 tool call。
      for (const piece of chunkString(`Let me read ${path} for you.`, 8)) {
        if (req.signal.aborted) return;
        yield { kind: "text", text: piece };
        await sleep(10);
      }
      const call: ParsedToolCall = {
        id,
        name: "Read",
        arguments: JSON.stringify({ path }),
      };
      yield { kind: "tool_call", call };
      yield { kind: "finish", reason: "tool_calls" };
      return;
    }

    // 第 2 阶段：tool 结果已在，简短总结。
    const toolResult = contentToString(req.messages.at(-1)?.content);
    const summary = `Done. The file is ${toolResult.length} bytes long.`;
    for (const piece of chunkString(summary, 8)) {
      if (req.signal.aborted) return;
      yield { kind: "text", text: piece };
      await sleep(10);
    }
    // 合成一个 usage delta，给 smoke-usage-model 测试 per-turn 计费路径用。
    // 数字是假的，但形状与 OpenAIProvider 走 stream_options.include_usage 一致。
    yield {
      kind: "usage",
      usage: { input: 42, output: 7, total: 49, cached: 0 },
    };
    yield { kind: "finish", reason: "stop" };
  }
}

/**
 * BadJsonProvider —— 用来验证"畸形 tool args 不挂掉 prompt loop"。
 *
 * 第 1 轮：emit Read tool_call，arguments 故意是截断的非法 JSON。
 * 第 2 轮：agent 应当把解析错误作为 tool message 写回；BadJson 检测到
 *           后 emit 一个修正过的 Read，模拟 LLM 自我纠错。
 * 第 3 轮：修正后的 Read 返回内容 → 收尾。
 */
export class BadJsonProvider implements LLMProvider {
  readonly name = "mock-bad-json";
  private callCounter = 0;

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const lastMsg = req.messages.at(-1);
    const lastIsTool = lastMsg?.role === "tool";

    if (!lastIsTool) {
      // 第 1 阶段：emit 畸形 JSON tool_call。
      this.callCounter += 1;
      const id = `bad_${this.callCounter}`;
      yield { kind: "text", text: "Trying to read with bad args..." };
      const call: ParsedToolCall = {
        id,
        name: "Read",
        // 截断 JSON：缺收尾的引号和右大括号
        arguments: '{"path": "package.json',
      };
      yield { kind: "tool_call", call };
      yield { kind: "finish", reason: "tool_calls" };
      return;
    }

    // 第 2 / 3 阶段：检查上一条 tool message。若是错误信息则重试，
    // 模拟 LLM 自我纠错；若是文件内容（已恢复）则收尾。
    const toolResult = contentToString(lastMsg?.content);
    const isError = /not valid JSON|must be a JSON object/.test(toolResult);

    if (isError) {
      // 第 2 阶段：自纠正。
      this.callCounter += 1;
      const id = `good_${this.callCounter}`;
      yield {
        kind: "text",
        text: " Got the error, retrying with valid JSON.",
      };
      const call: ParsedToolCall = {
        id,
        name: "Read",
        arguments: JSON.stringify({ path: "package.json" }),
      };
      yield { kind: "tool_call", call };
      yield { kind: "finish", reason: "tool_calls" };
      return;
    }

    // 第 3 阶段：修正后的 Read 已返回，收尾。
    yield {
      kind: "text",
      text: ` Read succeeded (${toolResult.length} bytes).`,
    };
    yield { kind: "finish", reason: "stop" };
  }
}

function lastUserContent(msgs: LLMMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user") return contentToString(m.content);
  }
  return "";
}

function extractPath(s: string): string | null {
  // 匹配 "read X"、"read the X" 或 "X"（引号包围）
  const quoted = s.match(/"([^"]+)"/);
  if (quoted) return quoted[1] ?? null;
  const verbed = s.match(/\bread\s+(?:the\s+)?(\S+)/i);
  if (verbed) return verbed[1] ?? null;
  return null;
}
