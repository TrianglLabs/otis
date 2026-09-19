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
    description:
      "Read a UTF-8 text, PDF, or DOCX file, or list a directory. Document extraction limits are reported in the result.",
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
    description:
      "Create or replace a UTF-8 text file with complete content. Cannot write PDF, Word, or other binary files.",
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
    description:
      "Replace one exact string in an existing UTF-8 text file. For DOCX or interactive PDF files, use edit_document.",
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
    name: "edit_document",
    description:
      "Edit a workspace DOCX with exact text replacements or fill an interactive PDF form. Creates a validated sibling copy by default. Set replace_original only when the user explicitly asks to overwrite the source; Otis keeps a private backup.",
    parameters: objectSchema(
      {
        path: stringSchema("Source .docx or .pdf path."),
        output_path: stringSchema(
          "Optional destination path for the edited copy. Defaults to '<source>-edited.<ext>' and must not already exist.",
        ),
        replace_original: booleanSchema(
          "Overwrite the source after validation and keep a private backup. Use only when the user explicitly requests replacement.",
        ),
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "DOCX only: exact, unique, single-paragraph text replacements applied in order.",
          items: objectSchema(
            {
              old: stringSchema("Exact existing text. Must occur once in the document."),
              new: stringSchema("Replacement text. Paragraph breaks and tabs are not supported."),
            },
            ["old", "new"],
          ),
        },
        form_fields: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string" },
          description:
            'PDF only: field names mapped to values. Use "true" or "false" for checkboxes and an exact listed option for choice fields.',
        },
      },
      ["path"],
    ),
  },
  {
    name: "publish_artifact",
    description:
      "Publish a finished Markdown, text, HTML, PDF, or DOCX file as a durable artifact in the conversation. Saves a private preview copy without changing the original. Use after generating or moving a deliverable with bash, and again after final edits. External files require permission. Does not bundle linked assets or JavaScript dependencies.",
    parameters: objectSchema(
      {
        path: stringSchema("Current relative or absolute path to the finished file."),
        artifact_id: stringSchema(
          "For a revision, the artifact_id returned by the original publication. Keep it when moving or renaming the same deliverable. Omit for a new artifact.",
        ),
      },
      ["path"],
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

  if (name === "edit_document") {
    if (!isRecord(input) || typeof input.path !== "string" || !input.path.trim()) {
      throw new Error('edit_document requires a non-empty string "path"')
    }
    const replacements = parseDocumentReplacements(input.replacements)
    const fields = parseDocumentFormFields(input.form_fields)
    if ((replacements === undefined) === (fields === undefined)) {
      throw new Error('edit_document requires exactly one of "replacements" or "form_fields"')
    }
    if (input.replace_original !== undefined && typeof input.replace_original !== "boolean") {
      throw new Error('edit_document "replace_original" must be a boolean')
    }
    const outputPath = parseOptionalString(input.output_path)
    const replaceOriginal = input.replace_original === true
    if (replaceOriginal && outputPath) {
      throw new Error('edit_document cannot use "output_path" with "replace_original"')
    }
    return {
      name,
      input: {
        path: input.path.trim(),
        outputPath,
        replaceOriginal,
        operation: replacements
          ? { kind: "replace_text", replacements }
          : { kind: "fill_pdf_form", fields: fields as Record<string, string> },
      },
    }
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

  if (name === "publish_artifact") {
    if (isRecord(input) && typeof input.path === "string" && input.path.trim()) {
      if (input.artifact_id !== undefined && (typeof input.artifact_id !== "string" || !input.artifact_id.trim()))
        throw new Error('publish_artifact "artifact_id" must be a non-empty string')
      return {
        name,
        input: {
          path: input.path.trim(),
          ...(input.artifact_id ? { artifactId: (input.artifact_id as string).trim() } : {}),
        },
      }
    }
    throw new Error('publish_artifact requires a non-empty string "path"')
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

function booleanSchema(description: string) {
  return { type: "boolean", description }
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

function parseDocumentReplacements(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("edit_document replacements must contain between 1 and 50 entries")
  }
  return value.map((replacement, index) => {
    if (
      !isRecord(replacement) ||
      typeof replacement.old !== "string" ||
      !replacement.old ||
      typeof replacement.new !== "string"
    ) {
      throw new Error(`edit_document replacements[${index}] requires non-empty "old" and string "new"`)
    }
    if (replacement.old === replacement.new) {
      throw new Error(`edit_document replacements[${index}] does not change the text`)
    }
    return { old: replacement.old, new: replacement.new }
  })
}

function parseDocumentFormFields(value: unknown) {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("edit_document form_fields must be a non-empty object")
  }
  const fields: Record<string, string> = {}
  for (const [name, fieldValue] of Object.entries(value)) {
    if (!name.trim() || typeof fieldValue !== "string") {
      throw new Error("edit_document form_fields must map non-empty field names to strings")
    }
    fields[name] = fieldValue
  }
  return fields
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
