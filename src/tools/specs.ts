// OpenAI tool specs declared to the LLM. The names + JSON schemas here MUST
// match the dispatcher in tools/router.ts.
//
// Three tools (per stage-3 user choice: fs + bash):
//   - read_file:  read a text file from the user's filesystem (via ACP fs.readTextFile)
//   - write_file: create/overwrite a text file (via ACP fs.writeTextFile, surfaced as diff)
//   - bash:       execute a shell command (via ACP terminal/* methods)

import type { ToolSpec } from "../llm/types.js";

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
        },
        required: ["path"],
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
        },
        required: ["path", "content"],
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
        },
        required: ["command"],
      },
    },
  },
];
