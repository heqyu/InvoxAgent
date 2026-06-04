// MockToolProvider — deterministic stand-in that exercises the tool-calling
// loop without a network round-trip.
//
// Behavior:
//   - Turn 1: emit a tool_call requesting Read on a path mentioned in
//     the user's message (looking for "read X" or quoted "X").
//   - Turn 2 (after the agent feeds back the file content as a tool message):
//     emit text deltas summarizing the file size, then finish.
//
// This lets smoke-tools.ts assert the entire round-trip (LLM→tool→LLM→user)
// without any LLM credentials.

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
      // Phase 1: emit a tool_call. Look at the latest user message for a path hint.
      const userMsg = lastUserContent(req.messages);
      const path = extractPath(userMsg) ?? "package.json";
      this.callCounter += 1;
      const id = `mock_${this.callCounter}`;
      // Stream a thinking phrase, then the tool call.
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

    // Phase 2: tool result is in. Summarize it.
    const toolResult = contentToString(req.messages.at(-1)?.content);
    const summary = `Done. The file is ${toolResult.length} bytes long.`;
    for (const piece of chunkString(summary, 8)) {
      if (req.signal.aborted) return;
      yield { kind: "text", text: piece };
      await sleep(10);
    }
    // Synthetic usage delta so the agent's per-turn report path is exercised
    // by smoke-usage-model.ts. Numbers are fake but match the shape that
    // OpenAIProvider would produce from `stream_options.include_usage`.
    yield {
      kind: "usage",
      usage: { input: 42, output: 7, total: 49, cached: 0 },
    };
    yield { kind: "finish", reason: "stop" };
  }
}

/**
 * BadJsonProvider — A3 / K5 acceptance harness.
 *
 * Phase 1: emit a Read tool_call with **deliberately malformed JSON**
 *   arguments (truncated string), simulating an LLM that occasionally
 *   ships broken tool args.
 *
 * Phase 2: agent should have written an error tool message back to history
 *   describing the parse failure (instead of crashing the prompt loop).
 *   We detect the error in history, then emit a corrected Read tool_call
 *   — modeling the LLM's "self-correction" path.
 *
 * Phase 3: after the corrected Read returns content, finish with a summary.
 *
 * This proves: bad JSON does not crash invox; LLM gets the error in
 * tool result and can recover.
 */
export class BadJsonProvider implements LLMProvider {
  readonly name = "mock-bad-json";
  private callCounter = 0;

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const lastMsg = req.messages.at(-1);
    const lastIsTool = lastMsg?.role === "tool";

    if (!lastIsTool) {
      // Phase 1: emit malformed JSON tool_call.
      this.callCounter += 1;
      const id = `bad_${this.callCounter}`;
      yield { kind: "text", text: "Trying to read with bad args..." };
      const call: ParsedToolCall = {
        id,
        name: "Read",
        // 截断的 JSON：缺收尾的引号和右大括号
        arguments: '{"path": "package.json',
      };
      yield { kind: "tool_call", call };
      yield { kind: "finish", reason: "tool_calls" };
      return;
    }

    // Phase 2 / 3: 看上一条 tool message 的内容。如果是错误信息，重试一次
    // 正确的 tool_call —— 模拟 LLM 自我纠错。如果是文件内容（recovery 已成
    // 功），收尾。
    const toolResult = contentToString(lastMsg?.content);
    const isError = /not valid JSON|must be a JSON object/.test(toolResult);

    if (isError) {
      // Phase 2: self-correct.
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

    // Phase 3: corrected read returned. Finish.
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
  // Matches "read X", "read the X", or quoted "X".
  const quoted = s.match(/"([^"]+)"/);
  if (quoted) return quoted[1] ?? null;
  const verbed = s.match(/\bread\s+(?:the\s+)?(\S+)/i);
  if (verbed) return verbed[1] ?? null;
  return null;
}
