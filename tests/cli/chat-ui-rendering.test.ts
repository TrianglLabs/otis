import { DiffRenderable, MarkdownRenderable, RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { colors } from "../../src/cli/theme.js"
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
