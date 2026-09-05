import {
  type BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  RGBA,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { TranscriptStore } from "../../src/app/transcript.js"
import { colors, selectTheme } from "../../src/cli/theme.js"
import { COLOR_PULSE_PERIOD_MS, TEXT_SHIMMER_PERIOD_MS } from "../../src/cli/ui/color-pulse.js"
import { LOCAL_DOWNLOADING_LABEL, LOCAL_LOADING_LABEL } from "../../src/cli/ui/format.js"
import { toFireworksPickerChoice } from "../../src/inference/picker-catalog.js"
import { fireworksModel } from "../../src/inference/types.js"
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
    expect(harness.text(`message-${reasoning.id}-reasoning-content`)).toContain("one\ntwo\nthree\nfour\nfive")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thought for 1.3s · click to expand")
    expect(harness.childIds(`message-${reasoning.id}`)).toEqual([
      `message-${reasoning.id}-reasoning-preview`,
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
    expect(markdown.content).toBe("one\ntwo\nthree\nfour\nfive")
    expect(harness.text(`message-${reasoning.id}-reasoning-header`)).toBe("Thinking… · click to expand")
    expect(markdown.fg?.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(harness.childIds(`message-${reasoning.id}`)).toEqual([
      `message-${reasoning.id}-reasoning-header`,
      `message-${reasoning.id}-reasoning-preview`,
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
      `message-${reasoning.id}-reasoning-preview`,
      `message-${reasoning.id}-reasoning-header`,
    ])
  })

  it("keeps collapsed streaming traces clipped without replacing the markdown prefix", async () => {
    const harness = await setup({ thinkingVisible: true })
    const transcript = new TranscriptStore()
    const reasoning = transcript.addReasoningMessage("alpha\n", { reasoningId: "reasoning_1", streaming: true })
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)
    await harness.renderOnce()

    const preview = harness.get<BoxRenderable>(`message-${reasoning.id}-reasoning-preview`)
    const markdown = harness.get<MarkdownRenderable>(`message-${reasoning.id}-reasoning-content`)
    expect(markdown.streaming).toBe(true)

    transcript.updateEntry(reasoning.id, { text: "alpha\nbravo\ncharlie\ndelta\necho" })
    harness.ui.renderTranscript(transcript.entries)
    await harness.renderOnce()

    expect(markdown.content).toBe("alpha\nbravo\ncharlie\ndelta\necho")
    expect(markdown).toBe(harness.get(`message-${reasoning.id}-reasoning-content`))
    expect(preview.height).toBeLessThanOrEqual(3)
    expect(preview.overflow).toBe("hidden")

    const lines = harness
      .captureCharFrame()
      .split("\n")
      .slice(preview.y, preview.y + preview.height)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
    expect(lines.join("\n")).toContain("echo")
    expect(lines.some((line) => line.includes("alpha"))).toBe(false)

    const clippedHeight = preview.height
    transcript.updateEntry(reasoning.id, { text: "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot" })
    harness.ui.renderTranscript(transcript.entries)
    await harness.renderOnce()
    expect(preview.height).toBe(clippedHeight)
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
      fireworksRow({ id: "accounts/fireworks/models/alpha", displayName: "Alpha", supportsImageInput: false }),
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

  it("pins pending user messages to the bottom with delivery labels", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    transcript.addUserMessage("active task")
    const queued = transcript.addQueuedUserMessage("separate follow-up")
    transcript.addAssistantMessage("still working")
    const steering = transcript.addSteeringUserMessage("focus on tests")

    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.childIds("messages")).toEqual([
      "message-1",
      "message-3",
      `message-${queued.id}`,
      `message-${steering.id}`,
    ])
    expect(harness.text(`message-${queued.id}-speaker`)).toBe("You · queued")
    expect(harness.text(`message-${steering.id}-speaker`)).toBe("You · steering")

    transcript.activatePendingUserMessage(steering.id)
    harness.ui.renderTranscript(transcript.entries)

    expect(harness.text(`message-${steering.id}-speaker`)).toBe("You")
    expect(harness.childIds("messages").at(-1)).toBe(`message-${queued.id}`)
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
    expect(frame).toContain("[↑↓] move · [n] new · [d] delete")
    expect(harness.get<TextRenderable>("session-panel-footer").height).toBe(1)
  })

  it("selects only models supplied by the verified model catalog", async () => {
    const onCloseModelPicker = vi.fn()
    const onSelectModel = vi.fn()
    const harness = await setup({ onCloseModelPicker, onSelectModel })
    const models = [
      fireworksRow(
        {
          id: "accounts/fireworks/models/alpha",
          displayName: "Alpha",
          contextLength: 128_000,
          supportsImageInput: true,
        },
        true,
      ),
      fireworksRow({ id: "accounts/fireworks/models/beta", displayName: "Beta", supportsImageInput: false }),
    ]

    harness.ui.showSessionPicker([{ id: "session", title: "Session", detail: "now" }])
    const sessionPanelWidth = harness.get<BoxRenderable>("session-panel").width
    harness.ui.showModelPicker(models)
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
    expect(harness.childIds("input-area")).toContain("input-box")
    expect(harness.get<BoxRenderable>("model-panel").width).toBe(sessionPanelWidth)
    expect(harness.text("model-row-0")).toBe("› Alpha")
    expect(harness.text("model-row-0-meta")).toBe("  128K · Vision")
    expect(harness.text("model-row-0")).not.toContain("accounts/fireworks")
    expect(harness.text("model-row-1")).toBe("  Beta")
    expect(harness.text("model-row-1-meta")).toBe("  Text")
    expect(harness.text("model-panel-footer")).toBe("[↑↓] move")
    expect(harness.text("model-panel-header")).toBe("Models")

    harness.press("down")
    harness.press("return")
    expect(onSelectModel).toHaveBeenCalledWith(models[1])

    harness.press("escape")
    expect(onCloseModelPicker).toHaveBeenCalledOnce()
    expect(harness.find("model-panel")).toBeUndefined()
  })

  it("labels models that have a Fast serving path", async () => {
    const harness = await setup()
    harness.ui.showModelPicker([
      fireworksRow(
        {
          id: "accounts/fireworks/models/kimi-k3",
          displayName: "Kimi K3",
          supportsImageInput: true,
          fastId: "accounts/fireworks/routers/kimi-k3-fast",
        },
        true,
      ),
      fireworksRow({ id: "accounts/fireworks/models/inkling", displayName: "Inkling", supportsImageInput: false }),
    ])

    expect(harness.text("model-row-0")).toBe("› Kimi K3")
    expect(harness.text("model-row-0-meta")).toBe("  Vision · Fast mode")
    expect(harness.text("model-row-1")).toBe("  Inkling")
    expect(harness.text("model-row-1-meta")).toBe("  Text")
    expect(harness.find("model-panel-header-helper")).toBeUndefined()
  })

  it("labels NVIDIA PAIR models with their model maximum and route", async () => {
    const harness = await setup()
    harness.ui.showModelPicker([
      { kind: "header", id: "header-pair", displayName: "NVIDIA PAIR" },
      {
        kind: "model",
        provider: "pair",
        id: "qwen3.5:35b",
        displayName: "Qwen 3.5 35B",
        baseURL: "http://127.0.0.1:11434",
        engine: "ollama",
        nativeContextLength: 262_144,
        quantization: "Q4_K_M",
        supportsImageInput: false,
        available: true,
        active: true,
        selectionKey: "pair:http://127.0.0.1:11434:qwen3.5:35b",
      },
    ])

    expect(harness.text("model-row-0")).toBe("NVIDIA PAIR")
    expect(harness.text("model-row-1")).toBe("› Qwen 3.5 35B  Ollama")
    const engine = harness.get<TextRenderable>("model-row-1").chunks.find((chunk) => chunk.text === "Ollama")
    expect(engine?.fg?.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(harness.text("model-row-1-meta")).toBe("  256K model max · Q4_K_M · Text")
  })

  it("does not invent missing NVIDIA PAIR context or quantization", async () => {
    const harness = await setup()
    harness.ui.showModelPicker([
      {
        kind: "model",
        provider: "pair",
        id: "remote/model",
        displayName: "Remote model",
        baseURL: "http://127.0.0.1:1234",
        engine: "lmstudio",
        supportsImageInput: true,
        available: true,
        active: false,
        selectionKey: "pair:http://127.0.0.1:1234:remote/model",
      },
    ])

    expect(harness.text("model-row-0")).toBe("› Remote model  LM Studio")
    expect(harness.text("model-row-0-meta")).toBe("  Context unavailable · Quant unavailable · Vision")
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
      fireworksRow(
        {
          id: "accounts/fireworks/models/alpha",
          displayName: "Alpha",
          contextLength: 128_000,
          supportsImageInput: true,
        },
        true,
      ),
      fireworksRow({ id: "accounts/fireworks/models/beta", displayName: "Beta", supportsImageInput: false }),
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

  it("lists local models above hosted models and greys out models that will not fit", async () => {
    const onSelectModel = vi.fn()
    const harness = await setup({ onSelectModel })
    const unavailable = {
      kind: "model" as const,
      provider: "local" as const,
      id: "Qwen/Qwen3.8-27B",
      displayName: "Qwen3.8 27B",
      contextLength: 262_144,
      supportsImageInput: false,
      available: false,
      recommended: false,
      availabilityLabel: "Needs 19 GB",
      downloaded: true,
      active: false,
    }
    const fireworks = fireworksRow(
      {
        id: "accounts/fireworks/models/alpha",
        displayName: "Alpha",
        supportsImageInput: false,
      },
      true,
    )

    harness.ui.showModelPicker([
      { kind: "header", id: "header-local", displayName: "Local" },
      unavailable,
      { kind: "header", id: "header-hosted", displayName: "Hosted" },
      fireworks,
    ])

    expect(harness.text("model-row-0")).toBe("LOCAL")
    expect(harness.text("model-row-1")).toBe("  Qwen3.8 27B  Downloaded")
    expect(harness.text("model-row-1-meta")).toBe("  Needs 19 GB · Text")
    expect(harness.get<TextRenderable>("model-row-1").fg.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(harness.text("model-row-2")).toBe("HOSTED")
    expect(harness.text("model-row-3")).toBe("› Alpha")

    harness.press("return")
    expect(onSelectModel).toHaveBeenCalledWith(fireworks)

    harness.press("up")
    expect(harness.text("model-row-1")).toBe("› Qwen3.8 27B  Downloaded")
    harness.press("return")
    expect(onSelectModel).toHaveBeenCalledTimes(1)
  })

  it("shows local download progress next to the model name", async () => {
    const harness = await setup()
    const local = {
      kind: "model" as const,
      provider: "local" as const,
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss 20B",
      contextLength: 131_072,
      supportsImageInput: false,
      available: true,
      recommended: true,
      availabilityLabel: "128K · MXFP4 · 16 GB",
      loadedContextLength: 131_072,
      downloaded: true,
      active: true,
    }

    harness.ui.showModelPicker([{ kind: "header", id: "header-local", displayName: "Local" }, local])
    expect(harness.text("model-row-1")).toBe("› gpt-oss 20B *  Downloaded")
    const downloaded = harness.get<TextRenderable>("model-row-1").chunks.find((chunk) => chunk.text === "Downloaded")
    expect(downloaded?.fg?.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(harness.text("model-row-1-meta")).toBe("  128K · MXFP4 · 16 GB · Text")

    harness.ui.setModelPickerStatus(local.id, { label: "Downloading 47%", kind: "progress" })
    expect(harness.text("model-row-1")).toBe("› gpt-oss 20B *  Downloading 47%")
    expect(harness.text("model-row-1-meta")).toBe("  128K · MXFP4 · 16 GB · Text")

    harness.ui.setModelPickerStatus(local.id, { label: LOCAL_LOADING_LABEL, kind: "progress" })
    expect(harness.text("model-row-1")).toBe("› gpt-oss 20B *  Loading")
  })

  it.each([
    `${LOCAL_DOWNLOADING_LABEL} 47%`,
    LOCAL_LOADING_LABEL,
  ])("shimmers %s for local model progress", async (label) => {
    const harness = await setup()
    vi.useFakeTimers()
    const local = {
      kind: "model" as const,
      provider: "local" as const,
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss 20B",
      contextLength: 131_072,
      supportsImageInput: false,
      available: true,
      recommended: false,
      availabilityLabel: "128K · MXFP4 · 16 GB",
      loadedContextLength: 131_072,
      downloaded: true,
      active: true,
    }

    harness.ui.showModelPicker([{ kind: "header", id: "header-local", displayName: "Local" }, local])
    harness.ui.setModelPickerStatus(local.id, { label, kind: "progress" })

    const first = statusLetterColors(harness.get<TextRenderable>("model-row-1"), label)
    expect(first.map((letter) => letter.text).join("")).toBe(label)
    expect(new Set(first.map((letter) => letter.color)).size).toBeGreaterThan(1)

    vi.advanceTimersByTime(TEXT_SHIMMER_PERIOD_MS / 2)
    const later = statusLetterColors(harness.get<TextRenderable>("model-row-1"), label)
    expect(later.map((letter) => letter.color)).not.toEqual(first.map((letter) => letter.color))
  })

  it("keeps the Local header in view when the first model is selected", async () => {
    const harness = await setup()
    const local = {
      kind: "model" as const,
      provider: "local" as const,
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss 20B",
      contextLength: 131_072,
      supportsImageInput: false,
      available: true,
      recommended: true,
      availabilityLabel: "Est. 128K · MXFP4 · 16 GB",
      downloaded: false,
      active: true,
    }
    const fireworks = Array.from({ length: 12 }, (_, index) =>
      fireworksRow({
        id: `accounts/fireworks/models/model-${index}`,
        displayName: `Model ${index}`,
        supportsImageInput: false,
      }),
    )

    harness.ui.showModelPicker([
      { kind: "header", id: "header-local", displayName: "Local" },
      local,
      { kind: "header", id: "header-hosted", displayName: "Hosted" },
      ...fireworks,
    ])
    await harness.renderOnce()

    for (let step = 0; step < 12; step += 1) harness.press("down")
    await harness.renderOnce()
    expect(harness.get<ScrollBoxRenderable>("model-rows").scrollTop).toBeGreaterThan(0)

    for (let step = 0; step < 20 && !harness.text("model-row-1").startsWith("›"); step += 1) {
      harness.press("up")
    }
    await harness.renderOnce()

    expect(harness.text("model-row-1")).toBe("› gpt-oss 20B *")
    expect(harness.text("model-row-1-meta")).toBe("  Est. 128K · MXFP4 · 16 GB · Text")
    expect(harness.get<ScrollBoxRenderable>("model-rows").scrollTop).toBe(0)
  })
})

function fireworksRow(fields: Parameters<typeof fireworksModel>[0], active = false) {
  return toFireworksPickerChoice(fireworksModel(fields), active ? fields.id : undefined)
}

function statusLetterColors(row: TextRenderable, label: string) {
  const letters = row.chunks.slice(-label.length)
  return letters.map((chunk) => ({
    text: chunk.text,
    color: chunk.fg ? chunk.fg.toInts().join(",") : "",
  }))
}
