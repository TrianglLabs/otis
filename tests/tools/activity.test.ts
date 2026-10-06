import { describe, expect, it } from "vitest"
import { describeToolCall } from "../../src/tools/activity.js"
import type { ToolAction, ToolActivityKind, ToolCall } from "../../src/tools/index.js"

type BashToolCall = Extract<ToolCall, { name: "bash" }>

describe("describeToolCall", () => {
  it("describes direct tool categories", () => {
    expect(
      describeToolCall({
        name: "web_search",
        input: { objective: "current release", searchQueries: ["release"] },
      }),
    ).toEqual({
      kind: "web_search",
      action: "web_search",
      subject: "current release",
      label: "Searching web: current release",
    })
    expect(
      describeToolCall({ name: "web_read", input: { url: "https://example.com/docs" } }),
    ).toEqual({
      kind: "web_read",
      action: "web_read",
      subject: "https://example.com/docs",
      label: "Reading web: https://example.com/docs",
    })
    expect(describeToolCall({ name: "recall", input: { query: "limiter design" } })).toEqual({
      kind: "memory",
      action: "recall",
      subject: "limiter design",
      label: "Recalling: limiter design",
    })
    expect(
      describeToolCall({
        name: "remember",
        input: { fact: "Deploys go through CI.", scope: "workspace", topic: "general" },
      }),
    ).toMatchObject({
      kind: "memory",
      action: "remember",
      label: "Remembering: Deploys go through CI.",
    })
    expect(
      describeToolCall({
        name: "forget",
        input: { fact: "Deploys go through CI.", scope: "global" },
      }),
    ).toMatchObject({
      kind: "memory",
      action: "forget",
      label: "Forgetting: Deploys go through CI.",
    })
    expect(describeToolCall({ name: "read", input: { path: "README.md" } })).toEqual({
      kind: "file_read",
      action: "read",
      subject: "README.md",
      label: "Reading files: README.md",
    })
    expect(describeToolCall({ name: "grep", input: { pattern: "TODO", path: "." } })).toEqual({
      kind: "file_search",
      action: "grep",
      subject: "TODO",
      label: "Searching files: TODO",
    })
    expect(describeToolCall({ name: "glob", input: { pattern: "**/*.ts", path: "." } })).toEqual({
      kind: "file_search",
      action: "glob",
      subject: "**/*.ts",
      label: "Finding files: **/*.ts",
    })
    expect(describeToolCall({ name: "write", input: { path: "README.md", content: "" } })).toEqual({
      kind: "file_write",
      action: "write",
      subject: "README.md",
      label: "Writing file: README.md",
    })
    expect(
      describeToolCall({ name: "edit", input: { path: "README.md", old: "a", new: "b" } }),
    ).toEqual({
      kind: "file_edit",
      action: "edit",
      subject: "README.md",
      label: "Editing file: README.md",
    })
    expect(
      describeToolCall({
        name: "edit_document",
        input: {
          path: "resume.docx",
          replaceOriginal: false,
          operation: { kind: "replace_text", replacements: [{ old: "a", new: "b" }] },
        },
      }),
    ).toEqual({
      kind: "file_edit",
      action: "edit_document",
      subject: "resume.docx",
      label: "Editing document: resume.docx",
    })
    expect(
      describeToolCall({ name: "document", input: { operation: "check", path: "plan.docx" } }),
    ).toEqual({
      kind: "file_inspect",
      action: "document_check",
      subject: "plan.docx",
      label: "Checking document: plan.docx",
    })
    expect(
      describeToolCall({ name: "agent", input: { description: "Map the notes", prompt: "List." } }),
    ).toEqual({
      kind: "agent",
      action: "agent",
      subject: "Map the notes",
      label: "Delegating: Map the notes",
    })
  })

  it.each<[string, BashToolCall["input"], ToolActivityKind, ToolAction]>([
    ["rg TODO packages", { command: "rg TODO packages" }, "file_search", "search_command"],
    ["  tree apps", { command: "  tree apps" }, "file_inspect", "inspect_command"],
    ["git status --short", { command: "git status --short" }, "git", "git_command"],
    ["npm test", { command: "npm test" }, "shell", "command"],
  ])("classifies bash command activity for %s", (_name, input, kind, action) => {
    expect(describeToolCall({ name: "bash", input })).toMatchObject({
      kind,
      action,
      subject: input.command,
    })
  })

  it("shortens long labels without changing the activity kind", () => {
    const command = `npm test ${"x".repeat(120)}`

    const activity = describeToolCall({ name: "bash", input: { command } })

    expect(activity.kind).toBe("shell")
    expect(activity.label).toHaveLength(113)
    expect(activity.label.endsWith("...")).toBe(true)
    // Surfaces that render the parts get the whole command and truncate for themselves.
    expect(activity.subject).toBe(command)
  })
})
