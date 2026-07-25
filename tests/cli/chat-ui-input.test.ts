import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { useChatHarness } from "./support/chat-ui-harness.js"

const themeCommands = [
  { name: "/theme", description: "Choose a theme" },
  { name: "/theme default", description: "" },
  { name: "/theme nord", description: "" },
  { name: "/theme bright", description: "" },
  { name: "/theme matrix", description: "" },
]

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
    expect(harness.childIds("command-menu")).toEqual(["command-row-0"])
    expect(harness.text("command-row-0")).toContain("/history")

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

    expect(harness.childIds("command-menu")).toEqual(["command-row-0", "command-row-1"])
    expect(harness.text("command-row-0")).toContain("/history")
    expect(harness.text("command-row-1")).toContain("/exit")
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

    harness.press("down")
    expect(onPreviewTheme).toHaveBeenCalledWith("default")

    harness.press("escape")
    expect(onCancelThemePreview).toHaveBeenCalledOnce()
  })

  it("opens theme choices when submitting the slash command", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.submitChat()

    expect(harness.childIds("command-menu")).toEqual([
      "command-row-0",
      "command-row-1",
      "command-row-2",
      "command-row-3",
    ])
  })

  it("opens theme choices when pressing return on the slash command", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.press("return")

    expect(harness.childIds("command-menu")).toEqual([
      "command-row-0",
      "command-row-1",
      "command-row-2",
      "command-row-3",
    ])
  })

  it("keeps the theme submenu open when the input clear emits its deferred empty change", async () => {
    const harness = await setup({
      commands: themeCommands,
    })

    harness.setChatInput("/theme")
    harness.press("return")
    expect(harness.childIds("command-menu")).toEqual([
      "command-row-0",
      "command-row-1",
      "command-row-2",
      "command-row-3",
    ])

    // Opening the submenu clears the input; TextareaRenderable.clear() emits its
    // content-changed event asynchronously, so the empty-string change arrives
    // after the submenu is shown. It must not dismiss the submenu.
    harness.setChatInput("")

    expect(harness.childIds("command-menu")).toEqual([
      "command-row-0",
      "command-row-1",
      "command-row-2",
      "command-row-3",
    ])
    expect(harness.text("command-row-1")).toContain("nord")
  })

  it("closes the theme submenu and resumes filtering when typing a new command", async () => {
    const harness = await setup({
      commands: [...themeCommands, { name: "/exit", description: "Exit Otis" }],
    })

    harness.setChatInput("/theme")
    harness.press("return")
    expect(harness.childIds("command-menu")).toHaveLength(4)

    // A real (non-empty) edit supersedes the theme submenu and filters commands.
    harness.setChatInput("/e")
    expect(harness.childIds("command-menu")).toEqual(["command-row-0"])
    expect(harness.text("command-row-0")).toContain("/exit")
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

  it("starts unconfigured and submits provider-specific hidden API keys", async () => {
    const onSetup = vi.fn()
    const onSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onSetup, onSetupSubmit })

    expect(harness.childIds("input-area")).toEqual(["setup-box"])
    expect(harness.text("setup-button")).toContain("Set up Otis")

    harness.press("return")
    expect(onSetup).toHaveBeenCalledOnce()

    harness.ui.showSetupInput("fireworks")
    await harness.typeText("fw_test_key")
    harness.submitSetup("")
    expect(onSetupSubmit).toHaveBeenCalledWith("fireworks", "fw_test_key")

    harness.ui.showSetupInput("parallel")
    await harness.typeText("parallel_test_key")
    harness.submitSetup("")
    expect(onSetupSubmit).toHaveBeenCalledWith("parallel", "parallel_test_key")

    harness.ui.showSetupStatus()
    expect(harness.text("setup-status")).toBe("Loading models...")

    harness.ui.showModelPicker([{ id: "accounts/fireworks/models/tool-model", displayName: "Tool Model" }])
    expect(harness.find("setup-status-box")).toBeUndefined()
    expect(harness.childIds("input-area")).toEqual([])
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
  })

  it("keeps API keys out of the visible input and clears them after an error", async () => {
    const onSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onSetupSubmit })
    harness.ui.showSetupInput("fireworks")

    await harness.typeText("first-secret")
    expect(harness.get<InputRenderable>("setup-input").plainText).toBe("")

    harness.ui.showSetupError("Try again")
    await harness.typeText("second-secret")
    harness.submitSetup("")

    expect(onSetupSubmit).toHaveBeenCalledWith("fireworks", "second-secret")
    expect(onSetupSubmit).not.toHaveBeenCalledWith("fireworks", "first-secret")
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
})
