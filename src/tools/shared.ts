// Shared constants across all tool specs.
//
// CHOICE: centralise the `description` parameter schema object that every
// tool includes. Updating the wording (e.g. for localisation) now requires
// a single edit instead of 7.

/**
 * The common `description` parameter schema shared by every tool spec.
 * Shown as the user-facing hint in the editor's tool-call card.
 */
export const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor.",
} as const;
