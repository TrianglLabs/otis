import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "../../src/inference/system-prompt.js"

describe("system prompt", () => {
  it("keeps sequence diagram guidance while avoiding mermaid syntax", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"))

    expect(prompt).toContain("show sequence diagrams")
    expect(prompt).toContain("Avoid mermaid diagrams")
  })

  it("names the web tools the runtime actually exposes", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"))

    expect(prompt).toContain("Use web_search for discovery and web_read for a specific URL.")
    expect(prompt).toContain("Provide 2-3 short search_queries for web_search when useful.")
    expect(prompt).not.toContain("radar")
    expect(prompt).not.toMatch(/\bvisit\b/)
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

  it("advertises skill metadata without eagerly loading skill instructions", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"), [
      {
        name: "review",
        description: "Review code & explain <risks>.",
        root: "/skills/review",
        instructionsPath: "/skills/review/SKILL.md",
      },
    ])

    expect(prompt).toContain('<skill name="review">Review code &amp; explain &lt;risks&gt;.</skill>')
    expect(prompt).toContain("call the skill tool to load its SKILL.md")
    expect(prompt).not.toContain("/skills/review")
  })
})
