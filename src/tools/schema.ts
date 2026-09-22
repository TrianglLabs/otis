import {
  DOCUMENT_OPERATIONS,
  type DocumentOperation,
  type EditDocumentOperation,
  TOOL_NAMES,
  type ToolCall,
  type ToolName,
} from "./types.js"

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
        path: stringSchema(
          "Optional resource path relative to the skill root. Defaults to SKILL.md.",
        ),
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
          description:
            "DOCX only: exact, unique, single-paragraph text replacements applied in order.",
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
    name: "document",
    description:
      "Create PDF/DOCX, inspect or edit existing PDF text, convert DOCX to PDF, or render PDF pages. Load the documents skill for specifications. Otis prepares and reuses private Python dependencies automatically; check only reports readiness. Output must be a new workspace path. Use edit_document for DOCX text replacements and PDF forms, and publish_artifact for final delivery.",
    parameters: objectSchema(
      {
        operation: { type: "string", enum: DOCUMENT_OPERATIONS },
        path: stringSchema(
          "Source workspace PDF for inspect-pdf, edit-pdf or render; source DOCX for convert.",
        ),
        spec_path: stringSchema(
          "Workspace JSON specification for create or edit-pdf. Read the documents skill's spec.md.",
        ),
        output_path: stringSchema(
          "New PDF/DOCX file for create, PDF file for edit-pdf/convert, or new image directory for render.",
        ),
        pages: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: integerSchema("1-based page number."),
          description: "Optional unique pages for inspect-pdf or render.",
        },
      },
      ["operation"],
    ),
  },
  {
    name: "save_attachment",
    description:
      "Save the original bytes of a session attachment to a new workspace file for editing or local processing. Select by SHA-256 or exact unique attachment name. Does not convert formats or overwrite files.",
    parameters: objectSchema(
      {
        attachment: stringSchema(
          "Attachment SHA-256 from its metadata, or its exact unique filename.",
        ),
        path: stringSchema("New workspace file path with the same extension as the attachment."),
      },
      ["attachment", "path"],
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
  const fields: Record<string, unknown> = isRecord(input) ? input : {}
  const text = (key: string) => {
    const value = fields[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const integer = (key: string) => {
    const value = fields[key]
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
  }

  switch (name) {
    case "web_search": {
      const objective = text("objective")
      if (!objective)
        throw new Error(
          'web_search requires a non-empty string "objective" and 1-3 "search_queries"',
        )
      const raw = fields.search_queries
      if (!Array.isArray(raw))
        throw new Error("search_queries must contain between 1 and 3 strings")
      const searchQueries = raw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
      if (
        searchQueries.length === 0 ||
        searchQueries.length > 3 ||
        searchQueries.length !== raw.length
      )
        throw new Error("search_queries must contain between 1 and 3 non-empty strings")
      return { name, input: { objective, searchQueries } }
    }
    case "web_read": {
      const url = text("url")
      if (!url) throw new Error('web_read requires a non-empty string "url"')
      return { name, input: { url, objective: text("objective") } }
    }
    case "skill": {
      const skill = text("skill")
      if (!skill) throw new Error('skill requires a non-empty string "skill"')
      return { name, input: { skill, path: text("path") } }
    }
    case "read": {
      const path = text("path")
      if (!path) throw new Error('read requires a non-empty string "path"')
      return { name, input: { path, offset: integer("offset"), limit: integer("limit") } }
    }
    case "grep": {
      const pattern = text("pattern")
      if (!pattern) throw new Error('grep requires a non-empty string "pattern"')
      return {
        name,
        input: {
          pattern,
          path: text("path") ?? ".",
          include: text("include"),
          maxResults: integer("max_results"),
        },
      }
    }
    case "glob": {
      const pattern = text("pattern")
      if (!pattern) throw new Error('glob requires a non-empty string "pattern"')
      return {
        name,
        input: { pattern, path: text("path") ?? ".", maxResults: integer("max_results") },
      }
    }
    case "write": {
      const path = text("path")
      if (!path || typeof fields.content !== "string")
        throw new Error('write requires string "path" and "content"')
      return { name, input: { path, content: fields.content } }
    }
    case "edit": {
      const path = text("path")
      if (!path || typeof fields.old !== "string" || typeof fields.new !== "string")
        throw new Error('edit requires string "path", "old", and "new"')
      return { name, input: { path, old: fields.old, new: fields.new } }
    }
    case "edit_document": {
      const path = text("path")
      if (!path) throw new Error('edit_document requires a non-empty string "path"')
      const replacements = fields.replacements
      if (
        replacements !== undefined &&
        (!Array.isArray(replacements) || replacements.length === 0 || replacements.length > 50)
      )
        throw new Error("edit_document replacements must contain between 1 and 50 entries")
      const formFields = fields.form_fields
      if (
        formFields !== undefined &&
        (!isRecord(formFields) || Object.keys(formFields).length === 0)
      )
        throw new Error("edit_document form_fields must be a non-empty object")
      if ((replacements === undefined) === (formFields === undefined))
        throw new Error('edit_document requires exactly one of "replacements" or "form_fields"')
      if (fields.replace_original !== undefined && typeof fields.replace_original !== "boolean")
        throw new Error('edit_document "replace_original" must be a boolean')
      const outputPath = text("output_path")
      const replaceOriginal = fields.replace_original === true
      if (replaceOriginal && outputPath)
        throw new Error('edit_document cannot use "output_path" with "replace_original"')
      let operation: EditDocumentOperation
      if (replacements) {
        operation = {
          kind: "replace_text",
          replacements: replacements.map((replacement, index) => {
            if (
              !isRecord(replacement) ||
              typeof replacement.old !== "string" ||
              !replacement.old ||
              typeof replacement.new !== "string"
            ) {
              throw new Error(
                `edit_document replacements[${index}] requires non-empty "old" and string "new"`,
              )
            }
            if (replacement.old === replacement.new)
              throw new Error(`edit_document replacements[${index}] does not change the text`)
            return { old: replacement.old, new: replacement.new }
          }),
        }
      } else {
        const values: Record<string, string> = {}
        for (const [key, value] of Object.entries(formFields ?? {})) {
          if (!key.trim() || typeof value !== "string")
            throw new Error("edit_document form_fields must map non-empty field names to strings")
          values[key] = value
        }
        operation = { kind: "fill_pdf_form", fields: values }
      }
      return { name, input: { path, outputPath, replaceOriginal, operation } }
    }
    case "document": {
      if (!DOCUMENT_OPERATIONS.includes(fields.operation as DocumentOperation))
        throw new Error("document requires a supported operation")
      const operation = fields.operation as DocumentOperation
      const required =
        operation === "check"
          ? []
          : operation === "create"
            ? ["spec_path", "output_path"]
            : operation === "inspect-pdf"
              ? ["path"]
              : operation === "edit-pdf"
                ? ["path", "spec_path", "output_path"]
                : ["path", "output_path"]
      const allowed = [
        "operation",
        ...required,
        ...(["inspect-pdf", "render"].includes(operation) ? ["pages"] : []),
      ]
      if (Object.keys(fields).some((key) => !allowed.includes(key)))
        throw new Error(`document has arguments that do not apply to ${operation}`)
      for (const key of required)
        if (!text(key)) throw new Error(`document ${operation} requires ${key}`)
      const pages = fields.pages
      if (
        pages !== undefined &&
        (!Array.isArray(pages) ||
          pages.length < 1 ||
          pages.length > 20 ||
          pages.some(
            (page) => typeof page !== "number" || !Number.isSafeInteger(page) || page < 1,
          ) ||
          new Set(pages).size !== pages.length)
      )
        throw new Error("document pages must contain 1–20 unique positive integers")
      return {
        name,
        input: {
          operation,
          ...(fields.path ? { path: text("path") } : {}),
          ...(fields.spec_path ? { specPath: text("spec_path") } : {}),
          ...(fields.output_path ? { outputPath: text("output_path") } : {}),
          ...(pages ? { pages: pages as number[] } : {}),
        },
      }
    }
    case "agent": {
      const description = text("description")
      const prompt = text("prompt")
      if (!description || !prompt)
        throw new Error('agent requires non-empty strings "description" and "prompt"')
      return { name, input: { description, prompt } }
    }
    case "save_attachment": {
      const attachment = text("attachment")
      const path = text("path")
      if (!attachment || !path)
        throw new Error('save_attachment requires non-empty strings "attachment" and "path"')
      return { name, input: { attachment, path } }
    }
    case "publish_artifact": {
      const path = text("path")
      if (!path) throw new Error('publish_artifact requires a non-empty string "path"')
      const artifactId = text("artifact_id")
      if (fields.artifact_id !== undefined && !artifactId)
        throw new Error('publish_artifact "artifact_id" must be a non-empty string')
      return { name, input: { path, ...(artifactId ? { artifactId } : {}) } }
    }
    case "bash": {
      const command = text("command")
      if (!command) throw new Error('bash requires a non-empty string "command"')
      return { name, input: { command, timeoutMs: integer("timeout_ms") } }
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
