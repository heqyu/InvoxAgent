// EchoProvider — deterministic, no-network LLM stub. Used when INVOX_API_KEY
// is absent (dev mode) and by the smoke test (offline acceptance).
//
// Behavior: returns `invox echo: you said "<last user message>". streaming works ✓`
// chunked into 8-char pieces with a small per-chunk delay so streaming is
// observable. Format preserved from stage 1 so the existing smoke assertions
// pass unchanged.

import type { LLMDelta, LLMProvider, LLMRequest } from "./types.js";

export class EchoProvider implements LLMProvider {
  readonly name = "echo";

  async *stream(req: LLMRequest): AsyncIterable<LLMDelta> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    const reply = `invox echo: you said "${text}". streaming works ✓`;
    for (const piece of chunkString(reply, 8)) {
      if (req.signal.aborted) return;
      yield { kind: "text", text: piece };
      await sleep(20);
    }
  }
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
