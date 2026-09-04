import { TOOL_NAMES, type ToolCall, type ToolName } from "./types.js"

export type ToolDefinition = {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Search the web for current or external information. Provide 2-3 focused keyword queries whenever possible.",
    parameters: objectSchema(
      {
        objective: stringSchema("Natural-language description of the information needed."),
        search_queries: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: stringSchema("Focused keyword query."),
          description: "One to three focused queries; two or three are recommended.",
        },
      },
      ["objective", "search_queries"],
    ),
  },
  {
    name: "web_read",
    description: "Read and extract relevant content from a known web URL.",
    parameters: objectSchema(
      {
        url: stringSchema("HTTP or HTTPS URL to read."),
        objective: stringSchema("Optional description of the information to extract."),
      },
      ["url"],
    ),
  },
  {
    name: "skill",
    description:
      "Load an available Agent Skill's SKILL.md instructions or a text resource inside that skill. Read SKILL.md before following a matching skill.",
    parameters: objectSchema(
      {
        skill: stringSchema("Available skill name."),
        path: stringSchema("Optional resource path relative to the skill root. Defaults to SKILL.md."),
      },
      ["skill"],
    ),
  },
  {
    name: "read",
    description: "Read a file or list a directory.",
    parameters: objectSchema(
      {
        path: stringSchema("Relative or absolute file or directory path."),
        offset: integerSchema("Optional 1-indexed line offset for files."),
        limit: integerSchema("Optional maximum number of lines for files."),
      },
      ["path"],
    ),
  },
  {
    name: "grep",
    description:
      "Search file contents using a regular expression. Returns matching lines with file paths and line numbers. Use this instead of bash grep/rg for searching code.",
    parameters: objectSchema(
      {
        pattern: stringSchema("Regular expression pattern to search for."),
        path: stringSchema("Directory or file to search in. Defaults to the workspace root."),
        include: stringSchema("Optional glob pattern to filter files by name (e.g. '*.ts')."),
        max_results: integerSchema("Optional maximum number of matching lines to return."),
      },
      ["pattern"],
    ),
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns matching file paths. Use this instead of bash find for discovering files.",
    parameters: objectSchema(
      {
        pattern: stringSchema("Glob pattern (e.g. '**/*.ts', 'src/*.json')."),
        path: stringSchema("Directory to search in. Defaults to the workspace root."),
        max_results: integerSchema("Optional maximum number of file paths to return."),
      },
      ["pattern"],
    ),
  },
  {
    name: "write",
    description: "Create or replace a file with complete content.",
    parameters: objectSchema(
      {
        path: stringSchema("Relative or absolute file path."),
        content: stringSchema("Complete file content."),
      },
      ["path", "content"],
    ),
  },
  {
    name: "edit",
    description: "Replace one exact string in an existing file.",
    parameters: objectSchema(
      {
        path: stringSchema("Relative or absolute file path."),
        old: stringSchema("Exact text to replace. Must appear once."),
        new: stringSchema("Replacement text."),
      },
      ["path", "old", "new"],
    ),
  },
  {
    name: "bash",
    description: "Run a shell command in the working directory.",
    parameters: objectSchema(
      {
        command: stringSchema("Shell command to run."),
        timeout_ms: integerSchema("Optional timeout in milliseconds."),
      },
      ["command"],
    ),
  },
  {
    name: "agent",
    description:
      "Delegate a read-only exploration or research subtask to a subagent that works with its own context and returns only a final report. Use it for broad codebase exploration or multi-source research that would otherwise flood this conversation with tool output. Several agent calls in one response run in parallel. The subagent cannot see this conversation, so the prompt must contain everything it needs and state exactly what to report back.",
    parameters: objectSchema(
      {
        description: stringSchema("Short label for the subtask, 3-7 words."),
        prompt: stringSchema("Complete, self-contained task brief including what to report back."),
      },
      ["description", "prompt"],
    ),
  },
]

export function parseSerializedToolCall(name: string, argumentsJSON: string): ToolCall {
  return parseStructuredToolCall(name, JSON.parse(argumentsJSON.trim() || "{}") as unknown)
}

export function parseStructuredToolCall(name: string, input: unknown): ToolCall {
  if (!isToolName(name)) throw new Error(`Unknown tool: ${name}`)

  if (name === "web_search") {
    if (isRecord(input) && typeof input.objective === "string" && input.objective.trim()) {
      const searchQueries = parseRequiredStringArray(input.search_queries, 3)
      return { name, input: { objective: input.objective.trim(), searchQueries } }
    }
    throw new Error('web_search requires a non-empty string "objective" and 1-3 "search_queries"')
  }

  if (name === "web_read") {
    if (isRecord(input) && typeof input.url === "string" && input.url.trim()) {
      return { name, input: { url: input.url.trim(), objective: parseOptionalString(input.objective) } }
    }
    throw new Error('web_read requires a non-empty string "url"')
  }

  if (name === "skill") {
    if (isRecord(input) && typeof input.skill === "string" && input.skill.trim()) {
      return { name, input: { skill: input.skill.trim(), path: parseOptionalString(input.path) } }
    }
    throw new Error('skill requires a non-empty string "skill"')
  }

  if (name === "read") {
    if (isRecord(input) && typeof input.path === "string" && input.path.trim()) {
      return {
        name,
        input: {
          path: input.path.trim(),
          offset: parseOptionalInteger(input.offset),
          limit: parseOptionalInteger(input.limit),
        },
      }
    }
    throw new Error('read requires a non-empty string "path"')
  }

  if (name === "grep") {
    if (isRecord(input) && typeof input.pattern === "string" && input.pattern.trim()) {
      return {
        name,
        input: {
          pattern: input.pattern.trim(),
          path: parseOptionalString(input.path) ?? ".",
          include: parseOptionalString(input.include),
          maxResults: parseOptionalInteger(input.max_results),
        },
      }
    }
    throw new Error('grep requires a non-empty string "pattern"')
  }

  if (name === "glob") {
    if (isRecord(input) && typeof input.pattern === "string" && input.pattern.trim()) {
      return {
        name,
        input: {
          pattern: input.pattern.trim(),
          path: parseOptionalString(input.path) ?? ".",
          maxResults: parseOptionalInteger(input.max_results),
        },
      }
    }
    throw new Error('glob requires a non-empty string "pattern"')
  }

  if (name === "write") {
    if (isRecord(input) && typeof input.path === "string" && input.path.trim() && typeof input.content === "string") {
      return { name, input: { path: input.path.trim(), content: input.content } }
    }
    throw new Error('write requires string "path" and "content"')
  }

  if (name === "edit") {
    if (
      isRecord(input) &&
      typeof input.path === "string" &&
      input.path.trim() &&
      typeof input.old === "string" &&
      typeof input.new === "string"
    ) {
      return { name, input: { path: input.path.trim(), old: input.old, new: input.new } }
    }
    throw new Error('edit requires string "path", "old", and "new"')
  }

  if (name === "agent") {
    if (
      isRecord(input) &&
      typeof input.description === "string" &&
      input.description.trim() &&
      typeof input.prompt === "string" &&
      input.prompt.trim()
    ) {
      return { name, input: { description: input.description.trim(), prompt: input.prompt.trim() } }
    }
    throw new Error('agent requires non-empty strings "description" and "prompt"')
  }

  if (isRecord(input) && typeof input.command === "string" && input.command.trim()) {
    return { name, input: { command: input.command.trim(), timeoutMs: parseOptionalInteger(input.timeout_ms) } }
  }
  throw new Error('bash requires a non-empty string "command"')
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false }
}

function stringSchema(description: string) {
  return { type: "string", description }
}

function integerSchema(description: string) {
  return { type: "integer", minimum: 1, description }
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function parseOptionalInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function parseRequiredStringArray(value: unknown, maxItems: number) {
  if (!Array.isArray(value)) throw new Error(`search_queries must contain between 1 and ${maxItems} strings`)
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
  if (items.length === 0 || items.length > maxItems || items.length !== value.length) {
    throw new Error(`search_queries must contain between 1 and ${maxItems} non-empty strings`)
  }
  return items
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
