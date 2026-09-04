import {
  type BoxRenderable,
  type InputRenderable,
  RGBA,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { colors } from "../../src/cli/theme.js"
import { COLOR_PULSE_PERIOD_MS, selectionOutline } from "../../src/cli/ui/color-pulse.js"
import { toFireworksPickerChoice } from "../../src/inference/picker-catalog.js"
import { fireworksModel } from "../../src/inference/types.js"
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
        { name: "/settings", description: "Configure Otis" },
        { name: "/exit", description: "Exit Otis" },
      ],
      onSubmit,
    })
    harness.ui.showChatLayout()

    harness.setChatInput("/h")
    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box"])
    expect(harness.text("command-row-0")).toBe("› /history")
    expect(harness.text("command-row-0-meta")).toBe("  Open session history")

    harness.press("return")
    expect(onSubmit).toHaveBeenCalledWith("/history")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("keeps commands selectable while a turn is busy", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({
      commands: [
        { name: "/new", description: "Start a new session" },
        { name: "/theme", description: "Choose a theme" },
      ],
      onSubmit,
    })
    harness.ui.showChatLayout()
    harness.ui.setBusy(true)

    harness.setChatInput("/new")
    expect(harness.text("command-row-0")).toBe("› /new")
    expect(harness.text("command-row-0-meta")).toBe("  Start a new session")

    harness.press("return")
    expect(onSubmit).toHaveBeenCalledWith("/new")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("turns the queue menu item into an editable queue command", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({
      commands: [{ name: "/queue", description: "Queue a separate follow-up", draft: "/queue " }],
      onSubmit,
    })
    harness.ui.showChatLayout()

    harness.setChatInput("/queue")
    harness.press("return")

    expect(harness.get<TextareaRenderable>("otis-input").plainText).toBe("/queue ")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows a second-level command menu and submits its hidden command value", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({ onSubmit })

    harness.ui.showCommandSubmenu([
      {
        name: "gpt-oss 20B",
        description: "MXFP4 · 12 GB",
        submission: "/settings delete-model openai/gpt-oss-20b",
      },
      {
        name: "Qwen3.8 27B",
        description: "Q4_K_M · 17 GB",
        submission: "/settings delete-model Qwen/Qwen3.8-27B",
      },
    ])

    expect(harness.text("command-row-0")).toBe("› gpt-oss 20B")
    expect(harness.text("command-row-0-meta")).toBe("  MXFP4 · 12 GB")
    expect(harness.find("model-panel")).toBeUndefined()
    harness.press("down")
    harness.press("return")
    expect(onSubmit).toHaveBeenCalledWith("/settings delete-model Qwen/Qwen3.8-27B")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("returns from a nested command submenu to its parent on Escape", async () => {
    const harness = await setup()
    const parent = [
      { name: "Hosted inference", description: "Add API key", submission: "/settings hosted" },
      { name: "Delete local model", description: "Choose a downloaded model", submission: "/settings delete-model" },
      { name: "Debug mode", description: "Off", submission: "/settings debug" },
    ]
    const showParent = vi.fn(() => harness.ui.showCommandSubmenu(parent))
    harness.ui.showCommandSubmenu(
      [
        {
          name: "gpt-oss 20B",
          description: "MXFP4 · 12 GB",
          submission: "/settings delete-model openai/gpt-oss-20b",
        },
      ],
      { onBack: showParent },
    )

    harness.press("escape")

    expect(showParent).toHaveBeenCalledOnce()
    expect(harness.text("command-row-0")).toBe("› Hosted inference")
    expect(harness.text("command-row-1")).toBe("  Delete local model")
    expect(harness.text("command-row-2")).toBe("  Debug mode")

    harness.press("escape")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("opens the settings submenu from the slash menu", async () => {
    let openSettings = () => {}
    const onSubmit = vi.fn((value: string) => {
      if (value === "/settings") openSettings()
    })
    const harness = await setup({
      commands: [
        { name: "/model", description: "Choose a model" },
        { name: "/settings", description: "Configure Otis" },
      ],
      onSubmit,
    })
    openSettings = () => {
      harness.ui.clearInput()
      harness.ui.showCommandSubmenu(
        [
          {
            name: "Hosted inference",
            description: "Add API key",
            submission: "/settings hosted",
          },
          {
            name: "Debug mode",
            description: "Off",
            submission: "/settings debug",
          },
        ],
        { onBack: () => harness.ui.showSlashCommandMenu() },
      )
      harness.ui.focusInput()
    }
    harness.setChatInput("/")
    harness.press("down")
    harness.press("return")

    // The native textarea may deliver the content-change event from clearInput
    // after the submenu has already been mounted.
    harness.get<TextareaRenderable>("otis-input").onContentChange?.({} as never)

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith("/settings")
    expect(harness.text("command-row-0")).toBe("› Hosted inference")
    expect(harness.text("command-row-1")).toBe("  Debug mode")

    harness.press("escape")
    expect(harness.get<TextareaRenderable>("otis-input").plainText).toBe("/")
    expect(harness.text("command-row-0")).toBe("› /model")
    expect(harness.text("command-row-1")).toBe("  /settings")

    harness.press("escape")
    expect(harness.find("command-menu")).toBeUndefined()
  })

  it("hides /fast unless the command list includes it", async () => {
    const harness = await setup({
      commands: [
        { name: "/model", description: "Choose a model" },
        { name: "/exit", description: "Exit Otis" },
      ],
    })
    harness.ui.showChatLayout()
    harness.setChatInput("/f")
    expect(harness.text("command-row-0")).toBe("  No matching commands")

    harness.ui.setCommands([
      { name: "/fast", description: "Toggle Fast serving" },
      { name: "/model", description: "Choose a model" },
    ])
    harness.setChatInput("/f")
    expect(harness.text("command-row-0")).toBe("› /fast")
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

  it("chooses local or hosted inference with arrow keys before accepting an API key", async () => {
    const onSetup = vi.fn()
    const onSetupInferenceChoice = vi.fn()
    const onSetupLocalInferenceChoice = vi.fn()
    const onSetupSubmit = vi.fn()
    const harness = await setup({
      configured: false,
      onSetup,
      onSetupInferenceChoice,
      onSetupLocalInferenceChoice,
      onSetupSubmit,
    })

    expect(harness.childIds("input-area")).toEqual(["setup-box"])
    expect(harness.childIds("setup-box")).toEqual(["setup-why", "setup-local", "setup-button-box"])
    expect(harness.text("setup-button")).toContain("Set up Otis")
    expect(harness.text("setup-why")).toBe("Your terminal agent, powered by open models.")
    expect(harness.text("setup-local")).toBe("Inspect files, edit code, run commands, and search the web.")
    await harness.renderOnce()
    expect(harness.get<BoxRenderable>("welcome-panel").width).toBe(72)

    harness.press("return")
    expect(onSetup).toHaveBeenCalledOnce()

    harness.ui.showSetupInferenceChoice()
    expect(harness.childIds("input-area")).toEqual(["setup-choice"])
    expect(harness.childIds("setup-choice")).toEqual([
      "setup-choice-heading",
      "setup-choice-cards",
      "setup-choice-hint",
    ])
    expect(harness.text("setup-choice-heading")).toBe("Choose where Otis thinks")
    expect(harness.find("setup-choice-subheading")).toBeUndefined()
    expect(harness.childIds("setup-choice-cards")).toEqual(["setup-choice-local", "setup-choice-hosted"])
    await harness.renderOnce()
    expect(harness.get<BoxRenderable>("welcome-panel").width).toBe(91)
    expect(
      harness
        .captureCharFrame()
        .split("\n")
        .some((line) => line.includes("Local inference") && line.includes("Hosted inference")),
    ).toBe(true)
    expect(harness.text("setup-choice-local-title")).toBe("Local inference")
    expect(harness.text("setup-choice-local-label")).toBe("Private, on your devices")
    expect(harness.text("setup-choice-local-description")).toBe("Run on this machine or use an NVIDIA PAIR cluster.")
    expect(harness.text("setup-choice-local-detail-0")).toBe("Managed llama.cpp built in.")
    expect(harness.text("setup-choice-local-detail-1")).toBe("PAIR supports Ollama and LM Studio.")
    expect(harness.find("setup-choice-local-detail-2")).toBeUndefined()
    expect(harness.text("setup-choice-hosted-label")).toBe("Powered by Fireworks")
    expect(harness.text("setup-choice-hosted-description")).toBe(
      "Fast remote inference with no local hardware requirements.",
    )
    expect(harness.text("setup-choice-hosted-detail-0")).toBe("Zero Data Retention by default.")
    expect(harness.text("setup-choice-hosted-detail-1")).toBe("Uses your own Fireworks API key.")
    expect(harness.text("setup-choice-hosted-detail-2")).toBe("Configure it anytime in Settings.")
    expect(harness.text("setup-choice-hint")).toBe("[←→] move · [enter] select")

    const localCard = harness.get<BoxRenderable>("setup-choice-local")
    const hostedCard = harness.get<BoxRenderable>("setup-choice-hosted")
    expect(Math.min(localCard.width, hostedCard.width)).toBeGreaterThanOrEqual(42)
    const localTitle = harness.get<TextRenderable>("setup-choice-local-title")
    const hostedTitle = harness.get<TextRenderable>("setup-choice-hosted-title")
    expect(localCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(false)
    expect(hostedCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(Math.abs(localTitle.x + localTitle.width / 2 - (localCard.x + localCard.width / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(hostedTitle.x + hostedTitle.width / 2 - (hostedCard.x + hostedCard.width / 2))).toBeLessThanOrEqual(
      1,
    )

    harness.press("return")
    expect(onSetupInferenceChoice).toHaveBeenLastCalledWith("local")
    harness.ui.showSetupLocalInferenceChoice()
    expect(harness.childIds("input-area")).toEqual(["setup-local-choice"])
    expect(harness.text("setup-local-choice-heading")).toBe("Choose local inference type")
    expect(harness.childIds("setup-local-choice-cards")).toEqual([
      "setup-local-choice-managed",
      "setup-local-choice-pair",
    ])
    expect(harness.text("setup-local-choice-managed-title")).toBe("This machine")
    expect(harness.text("setup-local-choice-managed-label")).toBe("Managed by Otis")
    expect(harness.text("setup-local-choice-managed-description")).toBe(
      "Download a curated model and run it with llama.cpp.",
    )
    expect(harness.text("setup-local-choice-managed-detail-0")).toBe("Recommended hardware:")
    expect(harness.text("setup-local-choice-managed-detail-1")).toBe("Apple silicon · 24 GB+ unified memory")
    expect(harness.text("setup-local-choice-managed-detail-2")).toBe("Linux · 24 GB+ RAM")
    expect(harness.text("setup-local-choice-managed-detail-3")).toBe("Vulkan GPU · 16 GB+ VRAM")
    expect(harness.find("setup-local-choice-managed-detail-4")).toBeUndefined()
    expect(harness.text("setup-local-choice-pair-title")).toBe("NVIDIA PAIR")
    expect(harness.text("setup-local-choice-pair-label")).toBe("Your home AI cluster")
    expect(harness.text("setup-local-choice-pair-description")).toBe("Let PAIR choose a computer for each request.")
    expect(harness.text("setup-local-choice-hint")).toContain("[esc] back")
    harness.press("right")
    harness.press("return")
    expect(onSetupLocalInferenceChoice).toHaveBeenLastCalledWith("pair")
    harness.ui.showSetupLocalInferenceChoice()
    harness.press("escape")
    expect(harness.childIds("input-area")).toEqual(["setup-choice"])
    harness.ui.showSetupInferenceChoice()
    harness.press("right")
    expect(harness.text("setup-choice-hosted-title")).toBe("Hosted inference")
    expect(hostedCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(false)
    expect(localCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    harness.press("left")
    expect(harness.text("setup-choice-local-title")).toBe("Local inference")
    harness.press("right")
    harness.press("return")
    expect(onSetupInferenceChoice).toHaveBeenLastCalledWith("hosted")

    harness.ui.showSetupInput()
    await harness.renderOnce()
    expect(harness.get<BoxRenderable>("welcome-panel").width).toBe(72)
    const setupInput = harness.get<InputRenderable>("setup-input")
    expect(setupInput.focused).toBe(true)
    harness.press("escape")
    expect(setupInput.focused).toBe(false)
    expect(harness.childIds("input-area")).toEqual(["setup-choice"])
    expect(harness.text("setup-choice-hosted-title")).toBe("Hosted inference")
    harness.ui.showSetupInput()
    expect(harness.text("setup-input-label")).toBe("Fireworks API key")
    expect(harness.childIds("setup-form")).toEqual(["setup-input-box", "setup-continue-box"])
    expect(harness.find("setup-message")).toBeUndefined()
    expect(harness.text("setup-continue")).toContain("Continue")
    await harness.typeText("fw_test_key")
    await harness.renderOnce()
    const continueButton = harness.get<TextRenderable>("setup-continue")
    await harness.mockMouse.click(continueButton.x + 1, continueButton.y)
    expect(onSetupSubmit).toHaveBeenCalledWith("fw_test_key")

    harness.ui.showSetupStatus()
    expect(harness.text("setup-status")).toBe("Loading models...")

    harness.ui.showModelPicker([
      toFireworksPickerChoice(
        fireworksModel({
          id: "accounts/fireworks/models/tool-model",
          displayName: "Tool Model",
          supportsImageInput: false,
        }),
      ),
    ])
    expect(harness.find("setup-status-box")).toBeUndefined()
    expect(harness.childIds("input-area")).toEqual([])
    expect(harness.childIds("chat-body")).toEqual(["model-panel", "messages"])
  })

  it("keeps PAIR available when managed local inference is unsupported", async () => {
    const onSetupInferenceChoice = vi.fn()
    const onSetupLocalInferenceChoice = vi.fn()
    const reason = "Local inference is not supported on win32/x64."
    const harness = await setup({
      configured: false,
      localInferenceUnavailableReason: reason,
      onSetupInferenceChoice,
      onSetupLocalInferenceChoice,
    })

    harness.ui.showSetupInferenceChoice()
    harness.press("left")
    harness.press("return")
    expect(onSetupInferenceChoice).toHaveBeenCalledWith("local")

    harness.ui.showSetupLocalInferenceChoice()
    expect(harness.text("setup-local-choice-message")).toBe(reason)
    harness.press("left")
    harness.press("return")
    expect(onSetupLocalInferenceChoice).toHaveBeenCalledWith("pair")
  })

  it("edits and submits both NVIDIA PAIR proxy endpoints in one form", async () => {
    const onPairSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onPairSetupSubmit })
    const endpoints = {
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    }

    harness.ui.showPairSetup("Confirm both endpoints.", "local", endpoints)
    await harness.renderOnce()

    expect(harness.childIds("input-area")).toEqual(["setup-pair-form"])
    expect(harness.get<BoxRenderable>("welcome-panel").width).toBe(91)
    expect(harness.text("setup-pair-heading")).toBe("NVIDIA PAIR endpoints")
    expect(harness.text("setup-pair-description")).toBe(
      "These are PAIR's standard proxy addresses, or your last saved addresses. Only one working endpoint is required. Change an address only if PAIR → Endpoints shows a different proxy port.",
    )
    expect(harness.text("setup-pair-ollama-label")).toBe("Ollama")
    expect(harness.text("setup-pair-lmstudio-label")).toBe("LM Studio")
    expect(harness.get<InputRenderable>("setup-pair-ollama-input").plainText).toBe(endpoints.ollama)
    expect(harness.get<InputRenderable>("setup-pair-lmstudio-input").plainText).toBe(endpoints.lmStudio)
    expect(harness.find("setup-pair-continue-box")).toBeUndefined()
    expect(harness.get<InputRenderable>("setup-pair-ollama-input").focused).toBe(true)
    const frame = harness.captureCharFrame()
    expect(frame).toContain("Ollama")
    expect(frame).toContain("LM Studio")
    expect(frame).toContain("http://127.0.0.1:11434")
    expect(frame).toContain("http://127.0.0.1:1234")

    harness.press("tab")
    expect(harness.get<InputRenderable>("setup-pair-ollama-input").focused).toBe(false)
    expect(harness.get<InputRenderable>("setup-pair-lmstudio-input").focused).toBe(true)
    harness.get<InputRenderable>("setup-pair-lmstudio-input").submit()
    expect(onPairSetupSubmit).toHaveBeenCalledWith(endpoints)

    harness.ui.showPairSetupError("LM Studio is unavailable.", "local", endpoints)
    expect(harness.text("setup-pair-message")).toBe("LM Studio is unavailable.")
    expect(harness.get<InputRenderable>("setup-pair-ollama-input").plainText).toBe(endpoints.ollama)
    expect(harness.get<InputRenderable>("setup-pair-lmstudio-input").plainText).toBe(endpoints.lmStudio)
    harness.press("escape")
    expect(harness.childIds("input-area")).toEqual(["setup-local-choice"])
  })

  it("shows API keys in the input and clears them after an error", async () => {
    const onSetupSubmit = vi.fn()
    const harness = await setup({ configured: false, onSetupSubmit })
    harness.ui.showSetupInput()

    await harness.typeText("first-secret")
    expect(harness.get<InputRenderable>("setup-input").plainText).toBe("first-secret")

    harness.ui.showSetupError("Try again", "choice")
    expect(harness.get<InputRenderable>("setup-input").plainText).toBe("")
    expect(harness.childIds("setup-form")).toEqual(["setup-input-box", "setup-message", "setup-continue-box"])
    expect(harness.text("setup-message")).toBe("Try again")
    await harness.typeText("second-secret")
    harness.submitSetup()

    expect(onSetupSubmit).toHaveBeenCalledWith("second-secret")
    expect(onSetupSubmit).not.toHaveBeenCalledWith("first-secret")
  })

  it("keeps both inference choices readable at 80 columns", async () => {
    const harness = await setup({ configured: false })
    harness.resize(80, 30)
    harness.ui.showSetupInferenceChoice()
    await harness.renderOnce()

    const frame = harness.captureCharFrame()
    expect(frame).toContain("____  _______________")
    expect(
      frame.split("\n").some((line) => line.includes("Local inference") && line.includes("Hosted inference")),
    ).toBe(true)
    expect(frame).toContain("Private, on your devices")
    expect(frame).toContain("Powered by Fireworks")
    expect(frame).toContain("[←→] move · [enter] select")

    harness.ui.showSetupLocalInferenceChoice()
    await harness.renderOnce()
    const localFrame = harness.captureCharFrame()
    expect(localFrame).toContain("This machine")
    expect(localFrame).toContain("NVIDIA PAIR")
    expect(localFrame).toContain("Managed by Otis")
    expect(localFrame).toContain("Your home AI cluster")

    harness.ui.showPairSetup("Confirm either or both endpoints.", "local", {
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
    await harness.renderOnce()
    const pairFrame = harness.captureCharFrame()
    expect(pairFrame).toContain("NVIDIA PAIR endpoints")
    expect(pairFrame).toContain("Ollama")
    expect(pairFrame).toContain("http://127.0.0.1:11434")
    expect(pairFrame).toContain("LM Studio")
    expect(pairFrame).toContain("http://127.0.0.1:1234")
    expect(pairFrame).toContain("[tab] switch endpoint · [enter] continue · [esc] back")
  })

  it("uses the model picker pulse for the selected inference card", async () => {
    vi.useFakeTimers()
    const harness = await setup({ configured: false })
    harness.ui.showSetupInferenceChoice()

    const localCard = harness.get<BoxRenderable>("setup-choice-local")
    const hostedCard = harness.get<BoxRenderable>("setup-choice-hosted")
    expect(localCard.borderColor.equals(RGBA.fromHex(selectionOutline(0)))).toBe(true)
    expect(hostedCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)

    vi.advanceTimersByTime(COLOR_PULSE_PERIOD_MS / 2)
    expect(localCard.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)

    harness.press("right")
    expect(localCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(hostedCard.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)

    harness.ui.showSetupLocalInferenceChoice()
    const managedCard = harness.get<BoxRenderable>("setup-local-choice-managed")
    const pairCard = harness.get<BoxRenderable>("setup-local-choice-pair")
    expect(managedCard.borderColor.equals(RGBA.fromHex(selectionOutline(0)))).toBe(true)
    expect(pairCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)

    vi.advanceTimersByTime(COLOR_PULSE_PERIOD_MS / 2)
    expect(managedCard.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)

    harness.press("right")
    expect(managedCard.borderColor.equals(RGBA.fromHex(colors.border))).toBe(true)
    expect(pairCard.borderColor.equals(RGBA.fromHex(colors.accent))).toBe(true)
  })

  it("returns to the configured input when hosted settings are cancelled", async () => {
    const harness = await setup({ configured: true })

    harness.ui.showSetupInput("", "configured")
    const setupInput = harness.get<InputRenderable>("setup-input")
    expect(setupInput.focused).toBe(true)
    expect(harness.childIds("input-area")).toEqual(["setup-form"])

    harness.press("escape")
    expect(setupInput.focused).toBe(false)
    expect(harness.get<TextareaRenderable>("otis-input").focused).toBe(true)
    expect(harness.childIds("input-area")).toEqual(["input-box"])
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
    const harness = await setup({ modelLabel: "Tool Model" })
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
    expect(hint.width).toBe(" Tool Model · ~/work/otis ".length)
    expect(harness.captureCharFrame()).toContain("Tool Model · ~/work/otis")
  })
})
