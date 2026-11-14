import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSystemPrompt } from "../../src/inference/system-prompt.js"
import { TOOL_DEFINITIONS } from "../../src/tools/index.js"

/** The computer the prompt names: this machine unless a test describes another. */
const computer = vi.hoisted(() => ({ platform: "linux" as NodeJS.Platform, os: "", arch: "" }))
vi.mock("../../src/local/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/local/paths.js")>()
  Object.assign(computer, actual.THIS_COMPUTER)
  return { ...actual, THIS_COMPUTER: computer }
})
const THIS_MACHINE = { ...computer }
afterEach(() => {
  Object.assign(computer, THIS_MACHINE)
})

describe("system prompt", () => {
  it("requires format and design preservation and only offers enabled document operations", () => {
    const prompt = buildSystemPrompt({ now: new Date(), tools: TOOL_DEFINITIONS })
    expect(prompt).toContain("Do not silently substitute Markdown")
    expect(prompt).toContain("Preserve existing formatting and design by default")
    expect(prompt).toContain("agreement to a new layout before recreating the document")
    expect(prompt).toContain("do not ask again")
    expect(prompt).toContain("changed text can reflow lines and pages")
    expect(prompt).toContain("Use save_attachment")
    expect(prompt).toContain("Use edit_document")
    expect(prompt).toContain("inspect-pdf/edit-pdf")
    expect(prompt).toContain("Distinguish structural/text checks from visual layout inspection")
    const narrowed = buildSystemPrompt({
      now: new Date(),
      tools: TOOL_DEFINITIONS.filter((tool) => tool.name !== "save_attachment"),
    })
    expect(narrowed).not.toContain("Use save_attachment")
    expect(narrowed).toContain("Attachment export is unavailable")
    expect(buildSystemPrompt({ now: new Date() })).not.toContain("Document work:")
  })

  it("names the computer's operating system and processor on every platform", () => {
    Object.assign(computer, { platform: "darwin", os: "macOS 26.1", arch: "arm64" })
    expect(buildSystemPrompt({ now: new Date() })).toContain(
      "The computer runs macOS 26.1 on arm64.",
    )
    Object.assign(computer, { platform: "linux", os: "Linux (Ubuntu 24.04.1 LTS)", arch: "x64" })
    expect(buildSystemPrompt({ now: new Date(), tools: TOOL_DEFINITIONS })).toContain(
      "The computer runs Linux (Ubuntu 24.04.1 LTS) on x64.",
    )
    // This machine, as read from the system itself.
    Object.assign(computer, THIS_MACHINE)
    const name = { darwin: /macOS [\d.]+/, linux: /Linux/, win32: /Windows 1[01]/ }[
      process.platform as "darwin" | "linux" | "win32"
    ]
    expect(buildSystemPrompt({ now: new Date() })).toMatch(
      new RegExp(`The computer runs ${name?.source ?? ".+"} .*on ${process.arch}\\.`),
    )
  })

  it("tells a Windows model that bash is Git Bash, only when bash is offered", () => {
    Object.assign(computer, { platform: "win32", os: "Windows 11", arch: "x64" })
    expect(buildSystemPrompt({ now: new Date(), tools: TOOL_DEFINITIONS })).toContain(
      "The computer runs Windows 11 on x64. bash runs commands in Git Bash",
    )
    const withoutBash = TOOL_DEFINITIONS.filter((tool) => tool.name !== "bash")
    expect(buildSystemPrompt({ now: new Date(), tools: withoutBash })).not.toContain("Git Bash")
    Object.assign(computer, { platform: "linux", os: "Linux", arch: "x64" })
    expect(buildSystemPrompt({ now: new Date(), tools: TOOL_DEFINITIONS })).not.toContain(
      "Git Bash",
    )
  })

  it("instructs final-path publication only when the tool is offered", () => {
    const withPublication = buildSystemPrompt({ now: new Date(), tools: TOOL_DEFINITIONS })
    expect(withPublication).toContain("call publish_artifact on its final path")
    expect(withPublication).toContain("do not publish artifacts")
    expect(withPublication).toContain("Do not use bash to bypass")
    expect(
      buildSystemPrompt({
        now: new Date(),
        tools: TOOL_DEFINITIONS.filter((tool) => tool.name !== "publish_artifact"),
      }),
    ).not.toContain("File deliverables:")
  })

  it("keeps diagram guidance capability-specific", () => {
    const prompt = buildSystemPrompt({ now: new Date("2026-07-16T12:00:00Z") })

    expect(prompt).not.toContain("show sequence diagrams")
    expect(prompt).toContain("Avoid mermaid diagrams")
  })

  it("advertises Mermaid only to interfaces with a Canvas", () => {
    const prompt = buildSystemPrompt({
      now: new Date("2026-07-16T12:00:00Z"),
      outputCapabilities: {
        mermaid: true,
      },
    })

    expect(prompt).toContain("lets the user open fenced Mermaid diagrams in a visual Canvas")
    expect(prompt).toContain("```mermaid")
    expect(prompt).toContain("use sequenceDiagram only for time-ordered interactions")
    expect(prompt).toContain("Every Mermaid diagram type renders, including mindmap")
    expect(prompt).not.toContain("Avoid mermaid diagrams")
  })

  it("advertises TeX math only to interfaces whose Canvas renders it", () => {
    const plain = buildSystemPrompt({ now: new Date("2026-07-16T12:00:00Z") })
    expect(plain).toContain("Avoid TeX math markup")

    const canvas = buildSystemPrompt({
      now: new Date("2026-07-16T12:00:00Z"),
      outputCapabilities: {
        mermaid: true,
        math: true,
      },
    })
    expect(canvas).toContain("Replies render TeX math")
    // Chat shows TeX literally, so formula-heavy answers are steered into a published document.
    expect(canvas).toContain("Single-dollar `$…$` stays plain text in chat")
    expect(canvas).toContain("publish it with publish_artifact")
    expect(canvas).not.toContain("Avoid TeX math markup")
  })

  it("names the web tools the runtime actually exposes", () => {
    const prompt = buildSystemPrompt({ now: new Date("2026-07-16T12:00:00Z") })

    expect(prompt).toContain("Use web_search for discovery and web_read for a specific URL.")
    expect(prompt).toContain("Provide 2-3 short search_queries for web_search when useful.")
    expect(prompt).not.toContain("radar")
    expect(prompt).not.toMatch(/\bvisit\b/)
  })

  it("explains delegation only when the agent tool is offered", () => {
    const now = new Date("2026-07-16T12:00:00Z")
    const withAgent = buildSystemPrompt({ now, tools: TOOL_DEFINITIONS })
    const withoutAgent = buildSystemPrompt({
      now: now,
      tools: TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent"),
    })

    expect(withAgent).toContain("Delegation:")
    expect(withAgent).toContain("call wait_coworkers")
    expect(withAgent).toContain("coworkers")
    expect(withoutAgent).not.toContain("Delegation:")
    expect(withoutAgent).not.toContain("Use agent")
    expect(withoutAgent).not.toContain("subagent")
    expect(buildSystemPrompt({ now })).not.toContain("Delegation:")
  })

  it("serializes escaped project instructions between the base prompt and current date", () => {
    const prompt = buildSystemPrompt({
      projectContext: [
        { path: "/work/project & tools/AGENTS.md", content: "Use strict TypeScript." },
      ],
      now: new Date("2026-07-16T12:00:00Z"),
    })

    const contextIndex = prompt.indexOf("<project_context>")
    const dateIndex = prompt.indexOf("2026-07-16")
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(dateIndex).toBeGreaterThan(contextIndex)
    expect(prompt).toContain(
      '<file path="/work/project &amp; tools/AGENTS.md">\nUse strict TypeScript.\n</file>',
    )
  })

  it("carries each memory scope's index, escaped, and points at recall for the rest", () => {
    const prompt = buildSystemPrompt({
      now: new Date("2026-07-16T12:00:00Z"),
      memory: [
        { scope: "workspace", content: "# Memory: otis\n\n- [[general]]\n- [[net & <io>]]\n" },
        { scope: "global", content: "- [[setup]]" },
      ],
    })
    expect(prompt).toContain(
      "<memory>\nWhat Otis remembers from earlier sessions, as each scope's index",
    )
    expect(prompt).toContain(
      '<scope name="workspace">\n# Memory: otis\n\n- [[general]]\n- [[net &amp; &lt;io&gt;]]\n</scope>\n<scope name="global">\n- [[setup]]\n</scope>\n</memory>',
    )
    expect(prompt).toContain("Read a topic with the recall tool")
    expect(prompt.indexOf("<memory>")).toBeLessThan(prompt.indexOf("The current date is"))
    expect(buildSystemPrompt({ now: new Date("2026-07-16T12:00:00Z") })).not.toContain("<memory>")
  })

  it("advertises skill metadata without eagerly loading skill instructions", () => {
    const prompt = buildSystemPrompt({
      now: new Date("2026-07-16T12:00:00Z"),
      skills: [
        {
          name: "review",
          description: "Review code & explain <risks>.",
          root: "/skills/review",
          instructionsPath: "/skills/review/SKILL.md",
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    })

    expect(prompt).toContain(
      '<skill name="review">Review code &amp; explain &lt;risks&gt;.</skill>',
    )
    expect(prompt).toContain("call the skill tool to load its SKILL.md")
    expect(prompt).not.toContain("/skills/review")
  })
})
