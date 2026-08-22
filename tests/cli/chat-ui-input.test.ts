import {
  type BoxRenderable,
  type InputRenderable,
  RGBA,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { colors } from "../../src/cli/theme.js"
import { CHAT_INPUT_HINT } from "../../src/cli/ui/format.js"
import { THEME_NAMES } from "../../src/local/settings.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

const themeCommands = [
  { name: "/theme", description: "Choose a theme" },
  ...THEME_NAMES.map((theme) => ({ name: `/theme ${theme}`, description: "" })),
]
const themeRowIDs = THEME_NAMES.map((_, index) => `command-row-${index}-box`)

describe("chat UI input", () => {
  const setup = useChatHarness()

  it("filters slash commands and submits the keyboard selection", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({
      commands: [
        { name: "/new", description: "Start a new session" },
        { name: "/history", description: "Open session history" },
        { name: "/debug", description: "Toggle debug messages" },
        { name: "/exit", description: "Exit Otis" },
      ],
      onSubmit,
    })
    harness.ui.showChatLayout()

    harness.setChatInput("/h")
    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box"])
    expect(harness.text("command-row-0")).toBe("› /history")
    expect(harness.text("command-row-0-meta")).toBe("  Open session history")
    expect(harness.get<BoxRenderable>("command-menu").border).toBe(true)
    expect(harness.get<BoxRenderable>("command-menu").borderStyle).toBe("rounded")
    expect(harness.get<BoxRenderable>("command-menu").backgroundColor.equals(RGBA.fromHex(colors.background))).toBe(
      true,
    )
    expect(harness.get<TextRenderable>("command-row-0").bg.equals(RGBA.fromHex(colors.background))).toBe(true)

    harness.press("return")
    expect(onSubmit).toHaveBeenCalledWith("/history")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("hides home-only commands on the welcome screen", async () => {
    const harness = await setup({
      commands: [
        { name: "/home", description: "Return home" },
        { name: "/new", description: "Start a new session" },
        { name: "/compact", description: "Compact context" },
        { name: "/history", description: "Open session history" },
        { name: "/exit", description: "Exit Otis" },
      ],
    })

    harness.setChatInput("/")

    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box", "command-row-1-box"])
    expect(harness.text("command-row-0")).toBe("› /history")
    expect(harness.text("command-row-0-meta")).toBe("  Open session history")
    expect(harness.text("command-row-1")).toBe("  /exit")
    expect(harness.text("command-row-1-meta")).toBe("  Exit Otis")
  })

  it("opens theme choices and previews the highlighted theme", async () => {
    const onPreviewTheme = vi.fn()
    const onCancelThemePreview = vi.fn()
    const harness = await setup({
      commands: themeCommands,
      theme: "matrix",
      onPreviewTheme,
      onCancelThemePreview,
    })

    harness.ui.showThemeMenu()
    // Theme choices render as just the theme name, with no `/theme ` prefix.
    expect(harness.text("command-row-0")).toContain("default")
    expect(harness.text("command-row-3")).toContain("matrix")
    expect(harness.text("command-row-4")).toContain("midnight")
    expect(harness.text("command-row-5")).toContain("graphite")

    harness.press("down")
    expect(onPreviewTheme).toHaveBeenCalledWith("midnight")

    harness.press("escape")
    expect(onCancelThemePreview).toHaveBeenCalledOnce()
  })

  it("opens theme choices when submitting the slash command", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.submitChat()

    expect(harness.childIds("command-menu")).toEqual(themeRowIDs)
  })

  it("opens theme choices when pressing return on the slash command", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.press("return")

    expect(harness.childIds("command-menu")).toEqual(themeRowIDs)
  })

  it("keeps the theme submenu open when the input clear emits its deferred empty change", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.press("return")
    expect(harness.childIds("command-menu")).toEqual(themeRowIDs)

    // Opening the submenu clears the input; TextareaRenderable.clear() emits its
    // content-changed event asynchronously, so the empty-string change arrives
    // after the submenu is shown. It must not dismiss the submenu.
    harness.setChatInput("")

    expect(harness.childIds("command-menu")).toEqual(themeRowIDs)
    expect(harness.text("command-row-1")).toContain("nord")
  })

  it("closes the theme submenu and resumes filtering when typing a new command", async () => {
    const harness = await setup({
      commands: [...themeCommands, { name: "/exit", description: "Exit Otis" }],
    })

    harness.setChatInput("/theme")
    harness.press("return")
    expect(harness.childIds("command-menu")).toHaveLength(THEME_NAMES.length)

    // A real (non-empty) edit supersedes the theme submenu and filters commands.
    harness.setChatInput("/e")
    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box"])
    expect(harness.text("command-row-0")).toBe("› /exit")
    expect(harness.text("command-row-0-meta")).toBe("  Exit Otis")
  })

  it("moves the input between welcome and chat layouts without duplicating ownership", async () => {
    const harness = await setup()

    expect(harness.childIds("welcome-panel")).toEqual(["input-area", "welcome-quit"])

    harness.ui.showChatLayout()
    expect(harness.childIds("root")).toEqual(["top-bar", "chat-body", "input-area"])
    expect(harness.childIds("chat-body")).toEqual(["messages"])

    harness.ui.showHomeLayout()
    expect(harness.childIds("root")).toEqual(["welcome"])
    expect(harness.childIds("welcome-panel")).toEqual(["input-area", "welcome-quit"])

    harness.ui.showChatLayout()
    expect(harness.childIds("chat-body")).toEqual(["messages"])
  })

  it("starts unconfigured and submits a Fireworks API key", async () => {
    const onSetup = vi.fn()
    const onSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onSetup, onSetupSubmit })

    expect(harness.childIds("input-area")).toEqual(["setup-box"])
    expect(harness.childIds("setup-box")).toEqual([
      "setup-why",
      "setup-hint",
      "setup-web",
      "setup-local",
      "setup-button-box",
    ])
    expect(harness.text("setup-button")).toContain("Set up Otis")
    expect(harness.text("setup-why")).toContain("Fireworks key")
    expect(harness.text("setup-hint")).toContain("open-weight models")
    expect(harness.text("setup-web")).toContain("Web search is included")
    expect(harness.text("setup-local")).toContain("your computer")

    harness.press("return")
    expect(onSetup).toHaveBeenCalledOnce()

    harness.ui.showSetupInput()
    expect(harness.text("setup-key-note")).toContain("stored only on this computer")
    await harness.typeText("fw_test_key")
    harness.submitSetup()
    expect(onSetupSubmit).toHaveBeenCalledWith("fw_test_key")

    harness.ui.showSetupStatus()
    expect(harness.text("setup-status")).toBe("Loading models...")

    harness.ui.showModelPicker([
      { id: "accounts/fireworks/models/tool-model", displayName: "Tool Model", supportsImageInput: false },
    ])
    expect(harness.find("setup-status-box")).toBeUndefined()
    expect(harness.childIds("input-area")).toEqual([])
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
  })

  it("shows API keys in the input and clears them after an error", async () => {
    const onSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onSetupSubmit })
    harness.ui.showSetupInput()

    await harness.typeText("first-secret")
    expect(harness.get<InputRenderable>("setup-input").plainText).toBe("first-secret")

    harness.ui.showSetupError("Try again")
    expect(harness.get<InputRenderable>("setup-input").plainText).toBe("")
    await harness.typeText("second-secret")
    harness.submitSetup()

    expect(onSetupSubmit).toHaveBeenCalledWith("second-secret")
    expect(onSetupSubmit).not.toHaveBeenCalledWith("first-secret")
  })

  it("submits multiline chat input and clears it", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({ onSubmit })
    harness.ui.showChatLayout()

    await harness.typeText("line one")
    harness.mockInput.pressEnter({ shift: true })
    await harness.typeText("line two")
    harness.mockInput.pressEnter()

    expect(onSubmit).toHaveBeenCalledWith("line one\nline two")

    harness.ui.clearInput()
    expect(harness.get<TextareaRenderable>("otis-input").plainText).toBe("")
  })

  it("routes Tab to the mode toggle", async () => {
    const onToggleMode = vi.fn()
    const harness = await setup({ onToggleMode })
    harness.ui.showChatLayout()

    harness.press("tab")
    expect(onToggleMode).toHaveBeenCalledOnce()

    harness.ui.setModeLabel("? ask")
    expect(harness.text("mode-label")).toBe("? ask")
  })

  it("shows pending image names and routes binary and path paste", async () => {
    const onImagePaste = vi.fn()
    const onImagePathPaste = vi.fn(() => true)
    const onRemoveLastImage = vi.fn(() => true)
    const harness = await setup({ onImagePaste, onImagePathPaste, onRemoveLastImage })
    harness.ui.showChatLayout()

    harness.ui.setImageAttachmentCount(2)
    expect(harness.childIds("input-area")).toEqual(["input-box"])
    expect(harness.childIds("input-box")).toEqual(["mode-label", "image-attachments", "otis-input", "input-hint"])
    expect(harness.text("image-attachments")).toBe("[Image 1] [Image 2]")

    const bytes = new Uint8Array([1, 2, 3])
    harness.renderer.keyInput.processPaste(bytes, { kind: "binary", mimeType: "image/png" })
    expect(onImagePaste).toHaveBeenCalledWith(bytes, "image/png")

    const path = "/tmp/dragged\\ image.png"
    harness.renderer.keyInput.processPaste(new TextEncoder().encode(path), { kind: "text" })
    expect(onImagePathPaste).toHaveBeenCalledWith(path)

    harness.press("backspace")
    expect(onRemoveLastImage).toHaveBeenCalledOnce()

    harness.ui.setImageAttachmentCount(0)
    expect(harness.find("image-attachments")).toBeUndefined()
  })

  it("keeps the mode label and model hint fixed on one line when the home input grows", async () => {
    const harness = await setup()
    const longInput = Array.from({ length: 12 }, (_, index) => `line ${index + 1} ${"x".repeat(70)}`).join("\n")
    harness.setChatInput(longInput)
    await harness.renderOnce()

    const input = harness.get<TextareaRenderable>("otis-input")
    const mode = harness.get<TextRenderable>("mode-label")
    const hint = harness.get<TextRenderable>("input-hint")

    expect(input.height).toBeGreaterThan(1)
    expect(mode.height).toBe(1)
    expect(hint.height).toBe(1)
    expect(mode.y).toBe(input.y)
    expect(hint.y).toBe(input.y)
    expect(hint.width).toBe(" Model: test ".length)
    expect(harness.captureCharFrame()).toContain("Model: test")
  })

  it("keeps the chat hints fixed on one line when the input grows", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    const longInput = Array.from({ length: 12 }, (_, index) => `line ${index + 1} ${"x".repeat(70)}`).join("\n")
    harness.setChatInput(longInput)
    await harness.renderOnce()

    const input = harness.get<TextareaRenderable>("otis-input")
    const mode = harness.get<TextRenderable>("mode-label")
    const hint = harness.get<TextRenderable>("input-hint")

    expect(input.height).toBeGreaterThan(1)
    expect(mode.height).toBe(1)
    expect(hint.height).toBe(1)
    expect(mode.y).toBe(input.y)
    expect(hint.y).toBe(input.y)
    expect(hint.width).toBe(CHAT_INPUT_HINT.length)
    expect(harness.captureCharFrame()).toContain("[TAB] mode · [ESC] interrupt")
  })
})
