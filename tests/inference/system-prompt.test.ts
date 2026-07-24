import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "../../src/inference/system-prompt.js"

describe("system prompt", () => {
  it("keeps sequence diagram guidance while avoiding mermaid syntax", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"))

    expect(prompt).toContain("show sequence diagrams")
    expect(prompt).toContain("Avoid mermaid diagrams")
  })

  it("serializes escaped project instructions between the base prompt and current date", () => {
    const prompt = buildSystemPrompt(
      [{ path: "/work/project & tools/AGENTS.md", content: "Use strict TypeScript." }],
      new Date("2026-07-16T12:00:00Z"),
    )

    const contextIndex = prompt.indexOf("<project_context>")
    const dateIndex = prompt.indexOf("2026-07-16")
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(dateIndex).toBeGreaterThan(contextIndex)
    expect(prompt).toContain('<file path="/work/project &amp; tools/AGENTS.md">\nUse strict TypeScript.\n</file>')
  })
})
