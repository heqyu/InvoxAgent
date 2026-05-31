// OpenAI tool specs declared to the LLM. The names + JSON schemas here MUST
// match the dispatcher in tools/router.ts.
//
// Three tools (per stage-3 user choice: fs + bash):
//   - read_file:  read a text file from the user's filesystem (via ACP fs.readTextFile)
//   - write_file: create/overwrite a text file (via ACP fs.writeTextFile, surfaced as diff)
//   - bash:       execute a shell command (via node:child_process spawn)
//
// Every tool also takes a `description` arg: a short human phrase the LLM
// fills with what it intends to do. The agent surfaces it as the ACP tool
// card's subtitle (rawInput.description) and the toolUpdate title — this is
// the trick the reference Zed agents use to make their cards readable, since
// Zed doesn't render command stdout inline anyway. Without it the card is
// just `bash: <cmd>` with no human context.

import type { ToolSpec } from "../llm/types.js";

const DESCRIPTION_FIELD = {
  type: "string",
  description:
    "A short human-readable phrase describing what this call is doing, " +
    "in the same language the user is using. Shown as the title of the " +
    "tool call card in the user's editor. Example: 'Read project README' " +
    "or '查看当前目录'.",
} as const;

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file from the user's filesystem and return its full contents. " +
        "Use absolute paths or paths relative to the session's cwd.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path, or path relative to session cwd.",
          },
          description: DESCRIPTION_FIELD,
        },
        required: ["path", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file with the given content. " +
        "The client may render this as a diff for the user.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path, or path relative to session cwd.",
          },
          content: {
            type: "string",
            description: "Full new contents of the file.",
          },
          description: DESCRIPTION_FIELD,
        },
        required: ["path", "content", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a shell command in the session's working directory. " +
        "Returns combined stdout/stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The full command line to run.",
          },
          description: DESCRIPTION_FIELD,
        },
        required: ["command", "description"],
      },
    },
  },
];
