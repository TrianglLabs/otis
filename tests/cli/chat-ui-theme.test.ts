import {
  type BoxRenderable,
  RGBA,
  type ScrollBoxRenderable,
  TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { colors, selectTheme } from "../../src/cli/theme.js"
import { TranscriptStore } from "../../src/cli/transcript.js"
import { THEME_NAMES, type ThemeName } from "../../src/local/settings.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

describe("chat UI theme switching", () => {
  const setup = useChatHarness()
  const themes: readonly ThemeName[] = THEME_NAMES

  // selectTheme mutates the shared module-level `colors` object; restore the
  // default theme so this file cannot leak state into sibling test files.
  afterEach(() => selectTheme("default"))

  it("recolors the app chrome (not just the transcript) when the theme changes", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    const root = harness.get<BoxRenderable>("root")
    const topBar = harness.get<BoxRenderable>("top-bar")
    const inputBox = harness.get<BoxRenderable>("input-box")
    const input = harness.get<TextareaRenderable>("otis-input")
    const messages = harness.get<ScrollBoxRenderable>("messages")

    // Starts on the default theme.
    expect(root.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)

    const setBackgroundColor = vi.spyOn(harness.renderer, "setBackgroundColor")
    const setFocusedTextColor = vi.spyOn(TextareaRenderable.prototype, "focusedTextColor", "set")
    harness.ui.startBusyIndicator()
    const agentBar = harness.get<TextRenderable>("agent-bar")
    const previous = selectTheme("bright") // mutate global colors -> bright
    harness.ui.setTheme("bright", previous)

    // App chrome picks up the new theme background.
    expect(root.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(topBar.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    // Borders and input text/cursor colors track the theme too.
    expect(inputBox.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(input.textColor.equals(RGBA.fromHex(colors.text))).toBe(true)
    expect(setFocusedTextColor).toHaveBeenCalledWith(colors.text)
    expect(input.cursorColor.equals(RGBA.fromHex(colors.accent))).toBe(true)
    expect(agentBar.fg.equals(RGBA.fromHex(colors.accent))).toBe(true)
    // ScrollBox hides its viewport/content behind getChildren(); they must still recolor.
    expect(messages.viewport.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(messages.content.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    // The renderer's terminal clear color is updated alongside the renderable tree.
    expect(setBackgroundColor).toHaveBeenCalledWith(colors.background)
  })

  it("recolors scrollbar track and thumb when the theme changes", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    harness.ui.showModelPicker([
      { id: "accounts/fireworks/models/alpha", displayName: "Alpha", supportsImageInput: false },
    ])

    const messages = harness.get<ScrollBoxRenderable>("messages")
    const modelRows = harness.get<ScrollBoxRenderable>("model-rows")

    const previous = selectTheme("bright")
    harness.ui.setTheme("bright", previous)

    expect(messages.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(messages.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)
    expect(modelRows.verticalScrollBar.slider.backgroundColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(modelRows.verticalScrollBar.slider.foregroundColor.equals(RGBA.fromHex(colors.muted))).toBe(true)
  })

  it("refreshes the detached busy wave background before mounting it", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()

    const previous = selectTheme("bright")
    harness.ui.setTheme("bright", previous)
    harness.ui.startBusyIndicator()

    const agentBar = harness.get<TextRenderable>("agent-bar")
    expect(agentBar.bg.equals(RGBA.fromHex(colors.background))).toBe(true)
  })

  it("recolors back to a prior theme without leaving stale colors", async () => {
    const harness = await setup()
    const root = harness.get<BoxRenderable>("root")

    const defaultPrevious = selectTheme("bright")
    harness.ui.setTheme("bright", defaultPrevious)
    expect(root.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)

    // Switching back to default must restore the default background everywhere.
    const brightPrevious = selectTheme("default")
    harness.ui.setTheme("default", brightPrevious)
    expect(root.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(root.backgroundColor.equals(RGBA.fromHex("#1A1A1A"))).toBe(true)
  })

  it("visits overlapping render trees only once when palette values collide", async () => {
    selectTheme("nord")
    const harness = await setup({ theme: "nord" })
    harness.ui.showChatLayout()

    const previousNord = selectTheme("bright")
    harness.ui.setTheme("bright", previousNord)
    expect(harness.get<BoxRenderable>("input-box").borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)

    const previousBright = selectTheme("nord")
    harness.ui.setTheme("nord", previousBright)
    expect(harness.get<TextRenderable>("input-hint").fg.equals(RGBA.fromHex(colors.muted))).toBe(true)
  })

  it("preserves the transcript viewport while refreshing themed content", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    for (let index = 1; index <= 40; index += 1) transcript.addAssistantMessage(`message ${index}`)
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    await harness.renderOnce()

    const messages = harness.get<ScrollBoxRenderable>("messages")
    messages.scrollTo(5)
    expect(messages.scrollTop).toBe(5)

    const previous = selectTheme("bright")
    harness.ui.setTheme("bright", previous)

    expect(messages.scrollTop).toBe(5)
  })

  it("recolors the detached chat layout before selecting a theme from home", async () => {
    selectTheme("bright")
    const harness = await setup({ theme: "bright" })

    const previous = selectTheme("matrix")
    harness.ui.setTheme("matrix", previous)
    harness.ui.showChatLayout()
    const chatBody = harness.get<BoxRenderable>("chat-body")
    const messages = harness.get<ScrollBoxRenderable>("messages")

    expect(chatBody.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(messages.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(messages.viewport.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
  })

  it("recolors the chat viewport from Matrix to Bright", async () => {
    selectTheme("matrix")
    const harness = await setup({ theme: "matrix" })
    harness.ui.showChatLayout()
    const messages = harness.get<ScrollBoxRenderable>("messages")

    const previous = selectTheme("bright")
    harness.ui.setTheme("bright", previous)

    expect(messages.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(messages.viewport.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
    expect(messages.content.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
  })

  it("updates mounted colors for every theme transition", async () => {
    selectTheme("default")
    const harness = await setup({ theme: "default" })
    harness.ui.showChatLayout()
    const root = harness.get<BoxRenderable>("root")
    const messages = harness.get<ScrollBoxRenderable>("messages")
    const input = harness.get<TextareaRenderable>("otis-input")

    for (const from of themes) {
      for (const to of themes) {
        if (from === to) continue
        const prior = selectTheme(from)
        harness.ui.setTheme(from, prior)
        const previous = selectTheme(to)
        harness.ui.setTheme(to, previous)

        expect(root.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
        expect(messages.viewport.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
        expect(messages.content.backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(true)
        expect(input.textColor.equals(RGBA.fromHex(colors.text))).toBe(true)
        expect(input.cursorColor.equals(RGBA.fromHex(colors.accent))).toBe(true)
      }
    }
  })
})
