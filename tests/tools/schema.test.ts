import { describe, expect, it } from "vitest"
import { parseStructuredToolCall, TOOL_DEFINITIONS } from "../../src/tools/schema.js"

describe("parseStructuredToolCall", () => {
  it("defines each supported tool exactly once", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "web_search",
      "web_read",
      "read",
      "grep",
      "glob",
      "write",
      "edit",
      "bash",
    ])
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
      parseStructuredToolCall("web_read", { url: " https://example.com/docs ", objective: " API limits " }),
    ).toEqual({
      name: "web_read",
      input: { url: "https://example.com/docs", objective: "API limits" },
    })
    expect(() => parseStructuredToolCall("web_search", { objective: "news", search_queries: [] })).toThrow(
      "search_queries",
    )
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

  it("preserves write and edit content exactly", () => {
    expect(parseStructuredToolCall("write", { path: " note.txt ", content: "  keep whitespace  " })).toEqual({
      name: "write",
      input: { path: "note.txt", content: "  keep whitespace  " },
    })

    expect(parseStructuredToolCall("edit", { path: " note.txt ", old: "  old  ", new: "  new  " })).toEqual({
      name: "edit",
      input: { path: "note.txt", old: "  old  ", new: "  new  " },
    })
  })

  it("parses grep input with defaults for optional fields", () => {
    expect(parseStructuredToolCall("grep", { pattern: "  TODO  " })).toEqual({
      name: "grep",
      input: { pattern: "TODO", path: ".", include: undefined, maxResults: undefined },
    })

    expect(
      parseStructuredToolCall("grep", { pattern: "TODO", path: " src ", include: "*.ts", max_results: 50 }),
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

    expect(parseStructuredToolCall("glob", { pattern: "*.json", path: "config", max_results: 100 })).toEqual({
      name: "glob",
      input: { pattern: "*.json", path: "config", maxResults: 100 },
    })
  })

  it("rejects unknown tools and missing required fields", () => {
    expect(() => parseStructuredToolCall("delete", { path: "README.md" })).toThrow("Unknown tool: delete")
    expect(() => parseStructuredToolCall("read", { path: "   " })).toThrow('read requires a non-empty string "path"')
    expect(() => parseStructuredToolCall("bash", { command: "" })).toThrow('bash requires a non-empty string "command"')
    expect(() => parseStructuredToolCall("grep", { pattern: "" })).toThrow('grep requires a non-empty string "pattern"')
    expect(() => parseStructuredToolCall("glob", { pattern: "" })).toThrow('glob requires a non-empty string "pattern"')
    expect(() => parseStructuredToolCall("web_read", { url: "" })).toThrow('web_read requires a non-empty string "url"')
  })
})
