// 工具规范共享常量。

/**
 * 所有工具 spec 共用的 `description` 参数 schema。
 * LLM 在每次调用工具时会传入一段简短文案，作为编辑器中工具卡片的标题。
 * 集中定义便于统一调整文案。
 */
export const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;
