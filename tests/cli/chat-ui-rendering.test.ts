import { DiffRenderable, MarkdownRenderable, RGBA, type ScrollBoxRenderable, type TextRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { colors, selectTheme } from "../../src/cli/theme.js"
import { TranscriptStore } from "../../src/cli/transcript.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

describe("chat UI rendering", () => {
  const setup = useChatHarness()

  it("updates streaming assistant markdown in place", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    const assistant = transcript.addAssistantMessage("")

    transcript.updateEntry(assistant.id, { text: "# Streaming heading", streaming: true })
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries, { scrollToBottom: true })

    const markdown = harness.get<MarkdownRenderable>(`message-${assistant.id}-content`)
    expect(markdown).toBeInstanceOf(MarkdownRenderable)
    expect(markdown).toMatchObject({
      streaming: true,
      internalBlockMode: "top-level",
      tableOptions: { style: "grid" },
    })
    expect(markdown.content).toContain("Streaming heading")

    transcript.updateEntry(assistant.id, { streaming: false })
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.get(`message-${assistant.id}-content`)).toBe(markdown)
    expect(markdown.streaming).toBe(false)
  })

  it("hides reasoning by default and toggles all traces with /thinking state", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    const reasoning = transcript.addReasoningMessage("one\ntwo\nthree\nfour\nfive", {
      reasoningId: "reasoning_1",
      durationMs: 1_250,
    })
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.find(`message-${reasoning.id}`)).toBeUndefined()

    harness.ui.setThinkingVisible(true)
    expect(harness.text(`message-${reasoning.id}-reasoning-content`)).toContain("three\nfour\nfive")
    expect(harness.text(`message-${reasoning.id}-reasoning-content`)).not.toContain("one")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thought for 1.3s · click to expand")
    expect(harness.childIds(`message-${reasoning.id}`)).toEqual([
      `message-${reasoning.id}-reasoning-content`,
      `message-${reasoning.id}-reasoning-header`,
    ])

    harness.ui.setThinkingVisible(false)
    expect(harness.find(`message-${reasoning.id}`)).toBeUndefined()
  })

  it("shows the streaming tail and expands an individual trace by mouse", async () => {
    const harness = await setup({ thinkingVisible: true })
    const transcript = new TranscriptStore()
    const reasoning = transcript.addReasoningMessage("one\ntwo\nthree\nfour\nfive", {
      reasoningId: "reasoning_1",
      streaming: true,
    })
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    const markdown = harness.get<MarkdownRenderable>(`message-${reasoning.id}-reasoning-content`)
    expect(markdown.content).toContain("three\nfour\nfive")
    expect(markdown.content).not.toContain("one")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thinking… · click to expand")
    expect(markdown.fg?.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(harness.childIds(`message-${reasoning.id}`)).toEqual([
      `message-${reasoning.id}-reasoning-header`,
      `message-${reasoning.id}-reasoning-content`,
    ])

    await harness.renderOnce()
    const toggle = harness.get<TextRenderable>(`message-${reasoning.id}-reasoning-header`)
    await harness.mockMouse.click(toggle.x + 1, toggle.y)

    expect(markdown.content).toContain("one\ntwo\nthree\nfour\nfive")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thinking… · click to collapse")

    transcript.updateEntry(reasoning.id, { streaming: false, durationMs: 800 })
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.get(`message-${reasoning.id}-reasoning-content`)).toBe(markdown)
    expect(markdown.content).toContain("one\ntwo\nthree\nfour\nfive")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thought for 800ms · click to collapse")
    expect(harness.childIds(`message-${reasoning.id}`)).toEqual([
      `message-${reasoning.id}-reasoning-content`,
      `message-${reasoning.id}-reasoning-header`,
    ])
  })

  it("uses the theme text color as the Markdown and fenced-code fallback", async () => {
    selectTheme("default")
    const harness = await setup()
    const transcript = new TranscriptStore()
    const assistant = transcript.addAssistantMessage("```\nsrc/\n```")
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    const previous = selectTheme("bright")
    harness.ui.setTheme("bright", previous)

    const markdown = harness.get<MarkdownRenderable>(`message-${assistant.id}-content`)
    expect(markdown.fg?.equals(RGBA.fromHex(colors.text))).toBe(true)
    selectTheme("default")
  })

  it("colors scrollbar track and thumb from the active theme", async () => {
    selectTheme("default")
    const harness = await setup()
    harness.ui.showChatLayout()

    const messages = harness.get<ScrollBoxRenderable>("messages")
    expect(messages.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(messages.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)

    harness.ui.showSessionPicker([{ id: "session_1", title: "Previous work", detail: "1h ago" }])
    const sessionRows = harness.get<ScrollBoxRenderable>("session-rows")
    expect(sessionRows.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(sessionRows.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)

    harness.ui.showModelPicker([{ id: "accounts/fireworks/models/alpha", displayName: "Alpha" }])
    const modelRows = harness.get<ScrollBoxRenderable>("model-rows")
    expect(modelRows.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(modelRows.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)
  })

  it("keeps the full transcript mounted and replaces rows whose identity changes", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    for (let index = 1; index <= 30; index += 1) transcript.addAssistantMessage(`message ${index}`)

    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.find("message-1")).toBeDefined()
    expect(harness.find("message-30")).toBeDefined()

    transcript.replaceMessages([{ role: "user", content: "new user" }])
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.childIds("message-1")).toEqual(["message-1-speaker", "message-1-content"])
    expect(harness.text("message-1-speaker")).toBe("You")
    expect(harness.text("message-1-content")).toBe("new user")
  })

  it("uses sticky bottom scrolling without forcing normal render jumps", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    transcript.addAssistantMessage("first")
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries, { scrollToBottom: true })

    const messages = harness.get<ScrollBoxRenderable>("messages")
    const scrollTo = vi.spyOn(messages, "scrollTo")
    transcript.addAssistantMessage("second")
    harness.ui.renderTranscript(transcript.entries)

    expect(messages).toMatchObject({ stickyScroll: true, stickyStart: "bottom" })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("renders tool diffs with the configured split view", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    const tool = transcript.addToolMessage("Editing src/app.ts", "file_edit")
    transcript.updateEntry(tool.id, {
      diff: ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
    })

    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    const diff = harness.get<DiffRenderable>(`message-${tool.id}-diff`)
    expect(diff).toBeInstanceOf(DiffRenderable)
    expect(diff).toMatchObject({ view: "split", wrapMode: "word", conceal: true })
    expect(diff.addedBg.equals(RGBA.fromHex(colors.diffAddedBg))).toBe(true)
    expect(diff.removedBg.equals(RGBA.fromHex(colors.diffRemovedBg))).toBe(true)
  })

  it("selects and deletes sessions from the keyboard", async () => {
    const onSelectSession = vi.fn()
    const onDeleteSession = vi.fn()
    const harness = await setup({ onDeleteSession, onSelectSession })

    harness.ui.showSessionPicker([
      { id: "default", title: "Default", detail: "now", active: true },
      { id: "session_1", title: "Previous work", detail: "1h ago" },
    ])

    expect(harness.childIds("chat-body")).toEqual(["session-panel", "messages"])
    expect(harness.text("session-row-0")).toContain("* Default")

    harness.press("down")
    harness.press("return")
    expect(onSelectSession).toHaveBeenCalledWith("session_1")

    harness.ui.showSessionPicker([
      { id: "default", title: "Default", detail: "now", active: true },
      { id: "session_1", title: "Previous work", detail: "1h ago" },
    ])
    harness.press("d")
    expect(onDeleteSession).toHaveBeenCalledWith("default")
    expect(harness.find("session-row-1")).toBeUndefined()
  })

  it("selects only models supplied by the verified model catalog", async () => {
    const onCloseModelPicker = vi.fn()
    const onSelectModel = vi.fn()
    const harness = await setup({ onCloseModelPicker, onSelectModel })
    const models = [
      {
        id: "accounts/fireworks/models/alpha",
        displayName: "Alpha",
        contextLength: 128_000,
        active: true,
      },
      { id: "accounts/fireworks/models/beta", displayName: "Beta" },
    ]

    harness.ui.showModelPicker(models)
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
    expect(harness.text("model-row-0")).toBe("* Alpha · 128K")
    expect(harness.text("model-row-0")).not.toContain("accounts/fireworks")
    expect(harness.text("model-row-1")).toBe("  Beta · —")

    harness.press("down")
    harness.press("return")
    expect(onSelectModel).toHaveBeenCalledWith(models[1])

    harness.press("escape")
    expect(onCloseModelPicker).toHaveBeenCalledOnce()
    expect(harness.find("model-panel")).toBeUndefined()
  })
})
