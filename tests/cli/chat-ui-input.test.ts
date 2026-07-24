import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { useChatHarness } from "./support/chat-ui-harness.js"

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
    expect(harness.childIds("setup-box")).toEqual([
      "setup-why",
      "setup-hint",
      "setup-parallel",
      "setup-local",
      "setup-button-box",
    ])
    expect(harness.text("setup-button")).toContain("Set up Otis")
    expect(harness.text("setup-why")).toContain("two keys")
    expect(harness.text("setup-hint")).toContain("open-weight models")
    expect(harness.text("setup-parallel")).toContain("search the web")
    expect(harness.text("setup-local")).toContain("your computer")

    harness.press("return")
    expect(onSetup).toHaveBeenCalledOnce()

    harness.ui.showSetupInput("fireworks")
    expect(harness.text("setup-key-note")).toContain("stored only on this computer")
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
