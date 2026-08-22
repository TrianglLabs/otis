import {
  type BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  RGBA,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { colors, selectTheme } from "../../src/cli/theme.js"
import { TranscriptStore } from "../../src/cli/transcript.js"
import { COLOR_PULSE_PERIOD_MS } from "../../src/cli/ui/color-pulse.js"
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
      tableOptions: {
        style: "grid",
        widthMode: "full",
        columnFitter: "proportional",
        wrapMode: "word",
        cellPaddingX: 1,
        cellPaddingY: 0,
        borders: true,
        outerBorder: true,
        borderStyle: "rounded",
        borderColor: colors.border,
        selectable: true,
      },
    })
    expect(markdown.content).toContain("Streaming heading")

    transcript.updateEntry(assistant.id, { streaming: false })
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.get(`message-${assistant.id}-content`)).toBe(markdown)
    expect(markdown.streaming).toBe(false)
  })

  it("renders markdown tables with rounded borders and readable cell spacing", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    transcript.addAssistantMessage("| Name | Status |\n| --- | --- |\n| Otis | Ready |")

    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)
    await harness.renderOnce()

    const frame = harness.captureCharFrame()
    expect(frame).toContain("╭")
    expect(frame).toContain("╮")
    expect(frame).toContain("│ Name ")
    expect(frame).toContain("│ Otis ")
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

  it("restores hidden reasoning traces in their original transcript positions", async () => {
    const harness = await setup({ thinkingVisible: true })
    const transcript = new TranscriptStore()
    const user = transcript.addUserMessage("question")
    const firstReasoning = transcript.addReasoningMessage("first thought", { reasoningId: "reasoning_1" })
    const tool = transcript.addToolMessage("Reading a file", "file_read")
    const secondReasoning = transcript.addReasoningMessage("second thought", { reasoningId: "reasoning_2" })
    const assistant = transcript.addAssistantMessage("answer")
    const visibleOrder = [user, firstReasoning, tool, secondReasoning, assistant].map((entry) => `message-${entry.id}`)

    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)
    expect(harness.childIds("messages")).toEqual(visibleOrder)

    harness.ui.setThinkingVisible(false)
    expect(harness.childIds("messages")).toEqual([user, tool, assistant].map((entry) => `message-${entry.id}`))

    harness.ui.setThinkingVisible(true)
    expect(harness.childIds("messages")).toEqual(visibleOrder)
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
    await harness.renderOnce()
    expect(messages.x + messages.width).toBe(harness.renderer.terminalWidth)
    const inputBox = harness.get<BoxRenderable>("input-box")
    expect(inputBox.x).toBe(1)
    expect(inputBox.x + inputBox.width).toBe(harness.renderer.terminalWidth - 1)

    harness.ui.showSessionPicker([{ id: "session_1", title: "Previous work", detail: "1h ago" }])
    const sessionRows = harness.get<ScrollBoxRenderable>("session-rows")
    expect(sessionRows.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(sessionRows.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)
    await harness.renderOnce()
    const sessionPanel = harness.get<BoxRenderable>("session-panel")
    expect(sessionRows.x + sessionRows.width).toBe(sessionPanel.x + sessionPanel.width)

    harness.ui.showModelPicker([
      { id: "accounts/fireworks/models/alpha", displayName: "Alpha", supportsImageInput: false },
    ])
    const modelRows = harness.get<ScrollBoxRenderable>("model-rows")
    expect(modelRows.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(modelRows.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)
    await harness.renderOnce()
    const modelPanel = harness.get<BoxRenderable>("model-panel")
    expect(modelRows.x + modelRows.width).toBe(modelPanel.x + modelPanel.width)
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
    expect(harness.text("session-row-0")).toContain("Default")
    expect(harness.text("session-row-0-meta")).toContain("now")

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

  it("keeps session history keyboard helpers visible when the list is long", async () => {
    const harness = await setup()
    harness.ui.showSessionPicker(
      Array.from({ length: 20 }, (_, index) => ({
        id: `session_${index}`,
        title: `Session ${index}`,
        detail: `${index}h ago`,
        active: index === 0,
      })),
    )
    await harness.renderOnce()

    const frame = harness.captureCharFrame()
    expect(frame).toContain("n new")
    expect(frame).toContain("d delete")
    expect(harness.get<TextRenderable>("session-panel-footer").height).toBe(2)
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
        supportsImageInput: true,
        active: true,
      },
      { id: "accounts/fireworks/models/beta", displayName: "Beta", supportsImageInput: false },
    ]

    harness.ui.showSessionPicker([{ id: "session", title: "Session", detail: "now" }])
    const sessionPanelWidth = harness.get<BoxRenderable>("session-panel").width
    harness.ui.showModelPicker(models)
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
    expect(harness.childIds("input-area")).toContain("input-box")
    expect(harness.get<BoxRenderable>("model-panel").width).toBe(sessionPanelWidth)
    expect(harness.text("model-row-0")).toBe("› Alpha")
    expect(harness.text("model-row-0-meta")).toBe("  128K · vision")
    expect(harness.text("model-row-0")).not.toContain("accounts/fireworks")
    expect(harness.text("model-row-1")).toBe("  Beta")
    expect(harness.text("model-row-1-meta")).toBe("")

    harness.press("down")
    harness.press("return")
    expect(onSelectModel).toHaveBeenCalledWith(models[1])

    harness.press("escape")
    expect(onCloseModelPicker).toHaveBeenCalledOnce()
    expect(harness.find("model-panel")).toBeUndefined()
  })

  it("pulses a reserved outline on the selected session and model rows", async () => {
    const harness = await setup()
    vi.useFakeTimers()

    harness.ui.showSessionPicker([
      { id: "default", title: "Default", detail: "now", active: true },
      { id: "session_1", title: "Previous work", detail: "1h ago" },
    ])
    expect(harness.text("session-row-0")).toBe("› Default")
    expect(harness.text("session-row-1")).toBe("  Previous work")
    const sessionSelected = harness.get<BoxRenderable>("session-row-0-box")
    const sessionOther = harness.get<BoxRenderable>("session-row-1-box")
    expect(sessionSelected.border).toBe(true)
    expect(sessionOther.border).toBe(true)
    expect(sessionSelected.borderStyle).toBe("rounded")
    expect(sessionOther.borderColor.equals(RGBA.fromHex(colors.surface))).toBe(true)
    expect(sessionSelected.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(false)
    expect(sessionSelected.borderColor.equals(RGBA.fromHex(colors.surface))).toBe(false)
    vi.advanceTimersByTime(COLOR_PULSE_PERIOD_MS / 2)
    expect(sessionSelected.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)
    expect(sessionOther.borderColor.equals(RGBA.fromHex(colors.surface))).toBe(true)
    expect(harness.get<BoxRenderable>("session-panel").border).toBe(false)

    harness.ui.showModelPicker([
      {
        id: "accounts/fireworks/models/alpha",
        displayName: "Alpha",
        contextLength: 128_000,
        supportsImageInput: true,
        active: true,
      },
      { id: "accounts/fireworks/models/beta", displayName: "Beta", supportsImageInput: false },
    ])
    expect(harness.text("model-row-0")).toBe("› Alpha")
    expect(harness.text("model-row-1")).toBe("  Beta")
    const modelSelected = harness.get<BoxRenderable>("model-row-0-box")
    const modelOther = harness.get<BoxRenderable>("model-row-1-box")
    expect(modelSelected.border).toBe(true)
    expect(modelOther.border).toBe(true)
    expect(modelSelected.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(false)
    expect(modelSelected.borderColor.equals(RGBA.fromHex(colors.surface))).toBe(false)
    vi.advanceTimersByTime(COLOR_PULSE_PERIOD_MS / 2)
    expect(modelSelected.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)
    expect(modelOther.borderColor.equals(RGBA.fromHex(colors.surface))).toBe(true)
    expect(harness.get<BoxRenderable>("model-panel").border).toBe(false)
  })
})
