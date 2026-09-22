import { describe, expect, it } from "vitest"
import { parseStructuredToolCall, TOOL_DEFINITIONS } from "../../src/tools/schema.js"

describe("parseStructuredToolCall", () => {
  it("defines each supported tool exactly once", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "web_search",
      "web_read",
      "skill",
      "read",
      "grep",
      "glob",
      "write",
      "edit",
      "edit_document",
      "document",
      "save_attachment",
      "publish_artifact",
      "bash",
      "agent",
    ])
  })

  it("parses publication paths and rejects missing paths", () => {
    expect(parseStructuredToolCall("publish_artifact", { path: " result.html " })).toEqual({
      name: "publish_artifact",
      input: { path: "result.html" },
    })
    for (const path of [undefined, "", "  ", 42]) {
      expect(() => parseStructuredToolCall("publish_artifact", { path })).toThrow(
        "non-empty string",
      )
    }
    expect(
      parseStructuredToolCall("publish_artifact", {
        path: "moved.md",
        artifact_id: " original-id ",
      }),
    ).toEqual({
      name: "publish_artifact",
      input: { path: "moved.md", artifactId: "original-id" },
    })
    for (const artifact_id of ["", " ", 42]) {
      expect(() =>
        parseStructuredToolCall("publish_artifact", { path: "moved.md", artifact_id }),
      ).toThrow("artifact_id")
    }
  })

  it("requires a source attachment identity and a destination", () => {
    expect(
      parseStructuredToolCall("save_attachment", {
        attachment: " resume.pdf ",
        path: " source.pdf ",
      }),
    ).toEqual({
      name: "save_attachment",
      input: { attachment: "resume.pdf", path: "source.pdf" },
    })
    for (const input of [
      {},
      { attachment: "resume.pdf" },
      { attachment: 12, path: "x.pdf" },
      { attachment: "x", path: " " },
    ]) {
      expect(() => parseStructuredToolCall("save_attachment", input)).toThrow("non-empty strings")
    }
  })

  it("parses subagent delegation and rejects empty briefs", () => {
    expect(
      parseStructuredToolCall("agent", {
        description: " Map the notes ",
        prompt: " List note files. ",
      }),
    ).toEqual({
      name: "agent",
      input: { description: "Map the notes", prompt: "List note files." },
    })
    expect(() => parseStructuredToolCall("agent", { description: "x", prompt: "  " })).toThrow(
      'agent requires non-empty strings "description" and "prompt"',
    )
    expect(() => parseStructuredToolCall("agent", { prompt: "y" })).toThrow(
      'agent requires non-empty strings "description" and "prompt"',
    )
  })

  it("requires focused web queries and preserves an optional read objective", () => {
    expect(
      parseStructuredToolCall("web_search", {
        objective: " Latest Fireworks model support ",
        search_queries: [" Fireworks tool calling ", " Fireworks serverless models "],
      }),
    ).toEqual({
      name: "web_search",
      input: {
        objective: "Latest Fireworks model support",
        searchQueries: ["Fireworks tool calling", "Fireworks serverless models"],
      },
    })
    expect(
      parseStructuredToolCall("web_read", {
        url: " https://example.com/docs ",
        objective: " API limits ",
      }),
    ).toEqual({
      name: "web_read",
      input: { url: "https://example.com/docs", objective: "API limits" },
    })
    expect(() =>
      parseStructuredToolCall("web_search", { objective: "news", search_queries: [] }),
    ).toThrow("search_queries")
  })

  it("keeps only positive integer options for local tools", () => {
    expect(parseStructuredToolCall("read", { path: " README.md ", offset: 2, limit: 10 })).toEqual({
      name: "read",
      input: { path: "README.md", offset: 2, limit: 10 },
    })

    expect(parseStructuredToolCall("bash", { command: " npm test ", timeout_ms: 0 })).toEqual({
      name: "bash",
      input: { command: "npm test", timeoutMs: undefined },
    })
  })

  it("parses progressive skill resource reads", () => {
    expect(
      parseStructuredToolCall("skill", { skill: " review ", path: " references/RULES.md " }),
    ).toEqual({
      name: "skill",
      input: { skill: "review", path: "references/RULES.md" },
    })
    expect(parseStructuredToolCall("skill", { skill: "review" })).toEqual({
      name: "skill",
      input: { skill: "review", path: undefined },
    })
    expect(parseStructuredToolCall("skill", { skill: "review", path: "   " })).toEqual({
      name: "skill",
      input: { skill: "review", path: undefined },
    })
  })

  it("preserves write and edit content exactly", () => {
    expect(
      parseStructuredToolCall("write", { path: " note.txt ", content: "  keep whitespace  " }),
    ).toEqual({
      name: "write",
      input: { path: "note.txt", content: "  keep whitespace  " },
    })

    expect(
      parseStructuredToolCall("edit", { path: " note.txt ", old: "  old  ", new: "  new  " }),
    ).toEqual({
      name: "edit",
      input: { path: "note.txt", old: "  old  ", new: "  new  " },
    })
  })

  it("parses native document edits and requires exactly one operation", () => {
    expect(
      parseStructuredToolCall("edit_document", {
        path: " resume.docx ",
        output_path: " resume-reviewed.docx ",
        replacements: [{ old: "old title", new: "new title" }],
      }),
    ).toEqual({
      name: "edit_document",
      input: {
        path: "resume.docx",
        outputPath: "resume-reviewed.docx",
        replaceOriginal: false,
        operation: { kind: "replace_text", replacements: [{ old: "old title", new: "new title" }] },
      },
    })
    expect(
      parseStructuredToolCall("edit_document", {
        path: "application.pdf",
        replace_original: true,
        form_fields: { Name: "Ada Lovelace", Confirmed: "true" },
      }),
    ).toEqual({
      name: "edit_document",
      input: {
        path: "application.pdf",
        outputPath: undefined,
        replaceOriginal: true,
        operation: { kind: "fill_pdf_form", fields: { Name: "Ada Lovelace", Confirmed: "true" } },
      },
    })
    expect(() => parseStructuredToolCall("edit_document", { path: "resume.docx" })).toThrow(
      "exactly one",
    )
    expect(() =>
      parseStructuredToolCall("edit_document", {
        path: "resume.docx",
        replacements: [{ old: "x", new: "y" }],
        form_fields: { Name: "Ada" },
      }),
    ).toThrow("exactly one")
    expect(() =>
      parseStructuredToolCall("edit_document", {
        path: "resume.docx",
        output_path: "copy.docx",
        replace_original: true,
        replacements: [{ old: "x", new: "y" }],
      }),
    ).toThrow("cannot use")
  })

  it("parses grep input with defaults for optional fields", () => {
    expect(parseStructuredToolCall("grep", { pattern: "  TODO  " })).toEqual({
      name: "grep",
      input: { pattern: "TODO", path: ".", include: undefined, maxResults: undefined },
    })

    expect(
      parseStructuredToolCall("grep", {
        pattern: "TODO",
        path: " src ",
        include: "*.ts",
        max_results: 50,
      }),
    ).toEqual({
      name: "grep",
      input: { pattern: "TODO", path: "src", include: "*.ts", maxResults: 50 },
    })
  })

  it("parses glob input with defaults for optional fields", () => {
    expect(parseStructuredToolCall("glob", { pattern: "  **/*.ts  " })).toEqual({
      name: "glob",
      input: { pattern: "**/*.ts", path: ".", maxResults: undefined },
    })

    expect(
      parseStructuredToolCall("glob", { pattern: "*.json", path: "config", max_results: 100 }),
    ).toEqual({
      name: "glob",
      input: { pattern: "*.json", path: "config", maxResults: 100 },
    })
  })

  it("rejects unknown tools and missing required fields", () => {
    expect(() => parseStructuredToolCall("delete", { path: "README.md" })).toThrow(
      "Unknown tool: delete",
    )
    expect(() => parseStructuredToolCall("read", { path: "   " })).toThrow(
      'read requires a non-empty string "path"',
    )
    expect(() => parseStructuredToolCall("bash", { command: "" })).toThrow(
      'bash requires a non-empty string "command"',
    )
    expect(() => parseStructuredToolCall("grep", { pattern: "" })).toThrow(
      'grep requires a non-empty string "pattern"',
    )
    expect(() => parseStructuredToolCall("glob", { pattern: "" })).toThrow(
      'glob requires a non-empty string "pattern"',
    )
    expect(() => parseStructuredToolCall("web_read", { url: "" })).toThrow(
      'web_read requires a non-empty string "url"',
    )
    expect(() => parseStructuredToolCall("skill", { skill: "" })).toThrow(
      'skill requires a non-empty string "skill"',
    )
  })
})
