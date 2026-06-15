// Known model parameter database — maps model IDs to their capabilities,
// context windows, and token limits. Used to enrich discovery results that
// only return id + owned_by from /v1/models.
//
// Models not in this table still work — they just show without metadata.
// User can override via providers.json modelInfo field.

export interface ModelInfo {
  /** Human-readable display name. */
  displayName: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Max output / completion tokens per request. */
  maxOutputTokens: number;
  /** Whether the model supports tool / function calling. */
  supportsTools: boolean;
  /** Whether the model supports image input (multimodal). */
  supportsImages: boolean;
  /** Whether the model is a chat model (vs TTS, ASR, embedding, etc.). */
  isChatModel: boolean;
  /** Brief description for UI tooltip. */
  description?: string;
}

/**
 * Built-in knowledge base of known model parameters.
 * Keyed by model ID (as returned by /v1/models).
 *
 * Sources:
 *   - OpenAI: https://platform.openai.com/docs/models
 *   - DeepSeek: https://platform.deepseek.com/api-docs
 *   - Mimo: https://platform.xiaomi.com/mimo/docs
 *   - Qwen: https://help.aliyun.com/zh/model-studio/
 */
export const KNOWN_MODELS: Record<string, ModelInfo> = {
  // ── OpenAI ────────────────────────────────────────────────────────
  "gpt-4o": {
    displayName: "GPT-4o",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Fast, multimodal flagship model.",
  },
  "gpt-4o-mini": {
    displayName: "GPT-4o Mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Affordable, fast model for most tasks.",
  },
  "o3": {
    displayName: "o3",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Reasoning model with strong problem-solving.",
  },
  "o3-mini": {
    displayName: "o3-mini",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsImages: false,
    isChatModel: true,
    description: "Cost-efficient reasoning model.",
  },
  "o4-mini": {
    displayName: "o4-mini",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Latest cost-efficient reasoning model.",
  },
  "gpt-4.1": {
    displayName: "GPT-4.1",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "1M context, strong instruction following.",
  },
  "gpt-4.1-mini": {
    displayName: "GPT-4.1 Mini",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "1M context, fast and affordable.",
  },
  "gpt-4.1-nano": {
    displayName: "GPT-4.1 Nano",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Smallest GPT-4.1, ultra-fast.",
  },

  // ── DeepSeek ──────────────────────────────────────────────────────
  "deepseek-chat": {
    displayName: "DeepSeek V3",
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsImages: false,
    isChatModel: true,
    description: "DeepSeek V3 general chat.",
  },
  "deepseek-reasoner": {
    displayName: "DeepSeek R1",
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    supportsTools: false,
    supportsImages: false,
    isChatModel: true,
    description: "DeepSeek R1 reasoning model.",
  },

  // ── Mimo (Xiaomi) ─────────────────────────────────────────────────
  "mimo-v2.5": {
    displayName: "Mimo V2.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Mimo V2.5 general chat, 1M context.",
  },
  "mimo-v2.5-pro": {
    displayName: "Mimo V2.5 Pro",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Mimo V2.5 Pro, enhanced reasoning.",
  },
  "mimo-v2-pro": {
    displayName: "Mimo V2 Pro",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Mimo V2 Pro.",
  },
  "mimo-v2-omni": {
    displayName: "Mimo V2 Omni",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Mimo V2 multimodal (text + image + audio).",
  },
  // Non-chat Mimo models
  "mimo-v2-tts": {
    displayName: "Mimo V2 TTS",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Text-to-speech model.",
  },
  "mimo-v2.5-tts": {
    displayName: "Mimo V2.5 TTS",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Text-to-speech model.",
  },
  "mimo-v2.5-tts-voiceclone": {
    displayName: "Mimo V2.5 Voice Clone",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Voice cloning TTS.",
  },
  "mimo-v2.5-tts-voicedesign": {
    displayName: "Mimo V2.5 Voice Design",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Custom voice design TTS.",
  },
  "mimo-v2.5-asr": {
    displayName: "Mimo V2.5 ASR",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Automatic speech recognition.",
  },

  // ── Qwen (Alibaba) ────────────────────────────────────────────────
  "qwen/qwen3-coder-30b": {
    displayName: "Qwen3 Coder 30B",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
    supportsImages: false,
    isChatModel: true,
    description: "Qwen3 Coder for coding tasks (local).",
  },
  "qwen/qwen3.5-35b-a3b": {
    displayName: "Qwen3.5 35B-A3B",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
    supportsImages: true,
    isChatModel: true,
    description: "Qwen3.5 MoE model (local).",
  },

  // ── Embedding models (non-chat) ───────────────────────────────────
  "text-embedding-qwen3-embedding-4b": {
    displayName: "Qwen3 Embedding 4B",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "Text embedding model.",
  },
  "text-embedding-ada-002": {
    displayName: "OpenAI Ada-002",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "OpenAI text embedding model.",
  },
  "text-embedding-3-small": {
    displayName: "OpenAI Embedding 3 Small",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "OpenAI text embedding model.",
  },
  "text-embedding-3-large": {
    displayName: "OpenAI Embedding 3 Large",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsTools: false,
    supportsImages: false,
    isChatModel: false,
    description: "OpenAI text embedding model.",
  },
};

/**
 * Look up known model info by ID. Returns undefined if the model
 * is not in the knowledge base (not an error — just means no metadata).
 */
export function lookupModelInfo(modelId: string): ModelInfo | undefined {
  return KNOWN_MODELS[modelId];
}

/**
 * Check if a model ID is a known non-chat model (TTS, ASR, embedding, etc.).
 * Unknown models are assumed to be chat models (safe default — don't filter them).
 */
export function isNonChatModel(modelId: string): boolean {
  const info = KNOWN_MODELS[modelId];
  return info !== undefined && !info.isChatModel;
}
