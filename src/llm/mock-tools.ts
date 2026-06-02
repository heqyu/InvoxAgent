// MockToolProvider — deterministic stand-in that exercises the tool-calling
// loop without a network round-trip.
//
// Behavior:
//   - Turn 1: emit a tool_call requesting read_file on a path mentioned in
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
  UserContent,
} from "./types.js";

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
        name: "read_file",
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
      usage: { input: 42, output: 7, total: 49 },
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

function contentToString(content: string | UserContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  // UserContent = string | ChatCompletionContentPart[]
  return (content as Array<{ type: string; text?: string }>)
    .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`))
    .join(" ");
}

function extractPath(s: string): string | null {
  // Matches "read X", "read the X", or quoted "X".
  const quoted = s.match(/"([^"]+)"/);
  if (quoted) return quoted[1] ?? null;
  const verbed = s.match(/\bread\s+(?:the\s+)?(\S+)/i);
  if (verbed) return verbed[1] ?? null;
  return null;
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
