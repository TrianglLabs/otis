import { describe, expect, it } from "vitest"
import { describeToolCall } from "../../src/tools/activity.js"
import type { ToolActivityKind, ToolCall } from "../../src/tools/index.js"

type BashToolCall = Extract<ToolCall, { name: "bash" }>

describe("describeToolCall", () => {
  it("describes direct tool categories", () => {
    expect(
      describeToolCall({ name: "web_search", input: { objective: "current release", searchQueries: ["release"] } }),
    ).toEqual({ kind: "web_search", label: "Searching web: current release" })
    expect(describeToolCall({ name: "web_read", input: { url: "https://example.com/docs" } })).toEqual({
      kind: "web_read",
      label: "Reading web: https://example.com/docs",
    })
    expect(describeToolCall({ name: "read", input: { path: "README.md" } })).toEqual({
      kind: "file_read",
      label: "Reading files: README.md",
    })
    expect(describeToolCall({ name: "grep", input: { pattern: "TODO", path: "." } })).toEqual({
      kind: "file_search",
      label: "Searching files: TODO",
    })
    expect(describeToolCall({ name: "glob", input: { pattern: "**/*.ts", path: "." } })).toEqual({
      kind: "file_search",
      label: "Finding files: **/*.ts",
    })
    expect(describeToolCall({ name: "write", input: { path: "README.md", content: "" } })).toEqual({
      kind: "file_write",
      label: "Writing file: README.md",
    })
    expect(describeToolCall({ name: "edit", input: { path: "README.md", old: "a", new: "b" } })).toEqual({
      kind: "file_edit",
      label: "Editing file: README.md",
    })
    expect(describeToolCall({ name: "agent", input: { description: "Map the notes", prompt: "List." } })).toEqual({
      kind: "agent",
      label: "Delegating: Map the notes",
    })
  })

  it.each<[string, BashToolCall["input"], ToolActivityKind]>([
    ["rg TODO packages", { command: "rg TODO packages" }, "file_search"],
    ["  tree apps", { command: "  tree apps" }, "file_inspect"],
    ["git status --short", { command: "git status --short" }, "git"],
    ["npm test", { command: "npm test" }, "shell"],
  ])("classifies bash command activity for %s", (_name, input, kind) => {
    expect(describeToolCall({ name: "bash", input })).toMatchObject({ kind })
  })

  it("shortens long labels without changing the activity kind", () => {
    const command = `npm test ${"x".repeat(120)}`

    const activity = describeToolCall({ name: "bash", input: { command } })

    expect(activity.kind).toBe("shell")
    expect(activity.label).toHaveLength(113)
    expect(activity.label.endsWith("...")).toBe(true)
  })
})
