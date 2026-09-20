import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "../../src/inference/system-prompt.js"
import { TOOL_DEFINITIONS } from "../../src/tools/index.js"

describe("system prompt", () => {
  it("requires format and design preservation and only offers enabled document operations", () => {
    const prompt = buildSystemPrompt([], new Date(), [], TOOL_DEFINITIONS)
    expect(prompt).toContain("Do not silently substitute Markdown")
    expect(prompt).toContain("Preserve existing formatting and design by default")
    expect(prompt).toContain("agreement to a new layout before recreating the document")
    expect(prompt).toContain("do not ask again")
    expect(prompt).toContain("changed text can reflow lines and pages")
    expect(prompt).toContain("Use save_attachment")
    expect(prompt).toContain("Use edit_document")
    expect(prompt).toContain("inspect-pdf/edit-pdf")
    expect(prompt).toContain("Distinguish structural/text checks from visual layout inspection")
    const narrowed = buildSystemPrompt(
      [],
      new Date(),
      [],
      TOOL_DEFINITIONS.filter((tool) => tool.name !== "save_attachment"),
    )
    expect(narrowed).not.toContain("Use save_attachment")
    expect(narrowed).toContain("Attachment export is unavailable")
    expect(buildSystemPrompt([], new Date(), [], [])).not.toContain("Document work:")
  })

  it("instructs final-path publication only when the tool is offered", () => {
    const withPublication = buildSystemPrompt([], new Date(), [], TOOL_DEFINITIONS)
    expect(withPublication).toContain("call publish_artifact on its final path")
    expect(withPublication).toContain("do not publish artifacts")
    expect(withPublication).toContain("Do not use bash to bypass")
    expect(
      buildSystemPrompt(
        [],
        new Date(),
        [],
        TOOL_DEFINITIONS.filter((tool) => tool.name !== "publish_artifact"),
      ),
    ).not.toContain("File deliverables:")
  })

  it("keeps diagram guidance capability-specific", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"))

    expect(prompt).not.toContain("show sequence diagrams")
    expect(prompt).toContain("Avoid mermaid diagrams")
  })

  it("advertises Mermaid only to interfaces with a Canvas", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"), [], [], { mermaid: true })

    expect(prompt).toContain("lets the user open fenced Mermaid diagrams in a visual Canvas")
    expect(prompt).toContain("```mermaid")
    expect(prompt).toContain("use sequenceDiagram only for time-ordered interactions")
    expect(prompt).toContain("does not support Mermaid mindmap or architecture diagrams")
    expect(prompt).not.toContain("Avoid mermaid diagrams")
  })

  it("names the web tools the runtime actually exposes", () => {
    const prompt = buildSystemPrompt([], new Date("2026-07-16T12:00:00Z"))

    expect(prompt).toContain("Use web_search for discovery and web_read for a specific URL.")
    expect(prompt).toContain("Provide 2-3 short search_queries for web_search when useful.")
    expect(prompt).not.toContain("radar")
    expect(prompt).not.toMatch(/\bvisit\b/)
  })

  it("explains delegation only when the agent tool is offered", () => {
    const now = new Date("2026-07-16T12:00:00Z")
    const withAgent = buildSystemPrompt([], now, [], TOOL_DEFINITIONS)
    const withoutAgent = buildSystemPrompt(
      [],
      now,
      [],
      TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent"),
    )

    expect(withAgent).toContain("Delegation:")
    expect(withAgent).toContain("they run in parallel")
    expect(withAgent).toContain("coworkers")
    expect(withoutAgent).not.toContain("Delegation:")
    expect(withoutAgent).not.toContain("Use agent")
    expect(withoutAgent).not.toContain("subagent")
    expect(buildSystemPrompt([], now)).not.toContain("Delegation:")
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
