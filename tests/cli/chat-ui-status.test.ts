import type { BoxRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { useChatHarness } from "./support/chat-ui-harness.js"

describe("chat UI status and prompts", () => {
  const setup = useChatHarness()

  it("shows the selected model in the home input and the interrupt hint in chat", async () => {
    const harness = await setup({ modelLabel: "Tool Model" })

    expect(harness.text("input-hint")).toBe(" Tool Model ")
    expect(harness.find("welcome-model")).toBeUndefined()

    harness.ui.showChatLayout()
    expect(harness.text("input-hint")).toBe(" [ESC] interrupt ")

    harness.ui.setModelLabel("Replacement")
    expect(harness.text("input-hint")).toBe(" [ESC] interrupt ")
    harness.ui.showHomeLayout()
    expect(harness.text("input-hint")).toBe(" Replacement ")
  })

  it("formats local stats and keeps labeled zero values", async () => {
    const harness = await setup()

    harness.ui.setStats({
      streak: 7,
      totalTokens: 1_250_000,
      sessionCount: 12,
      avgTokensPerSession: 24_600,
      avgSessionSeconds: 420,
    })

    expect(harness.text("welcome-stat-value-0")).toBe("7")
    expect(harness.text("welcome-stat-label-0")).toBe("day streak")
    expect(harness.text("welcome-stat-value-1")).toBe("1.3M")
    expect(harness.text("welcome-stat-value-2")).toBe("25K")
    expect(harness.text("welcome-stat-value-3")).toBe("7M")

    harness.ui.setStats({
      streak: 0,
      totalTokens: 0,
      sessionCount: 0,
      avgTokensPerSession: 0,
      avgSessionSeconds: 0,
    })
    expect(harness.text("welcome-stat-value-0")).toBe("0")
    expect(harness.text("welcome-stat-label-0")).toBe("day streak")
    expect(harness.text("welcome-stat-value-1")).toBe("0")
    expect(harness.text("welcome-stat-label-1")).toBe("all-time tokens")
    expect(harness.text("welcome-stat-value-2")).toBe("0")
    expect(harness.text("welcome-stat-label-2")).toBe("tokens/session")
    expect(harness.text("welcome-stat-value-3")).toBe("0S")
    expect(harness.text("welcome-stat-label-3")).toBe("time/session")
  })

  it("renders stat boxes with the same rounded border style as the input box", async () => {
    const harness = await setup()
    const inputBox = harness.get<BoxRenderable>("input-box")

    for (let index = 0; index < 4; index += 1) {
      const statBox = harness.get<BoxRenderable>(`welcome-stat-${index}`)
      expect(statBox.borderStyle).toBe(inputBox.borderStyle)
      expect(statBox.borderStyle).toBe("rounded")
    }
  })

  it("hides stats before credentials and reveals labeled zeros after setup", async () => {
    const harness = await setup({ configured: false, statsVisible: false })

    expect(harness.find("welcome-stats-row")).toBeUndefined()
    harness.ui.setConfigured()

    expect(harness.text("welcome-stat-value-0")).toBe("0")
    expect(harness.text("welcome-stat-label-3")).toBe("time/session")
  })

  it("requires two escape presses to interrupt a busy turn", async () => {
    const onInterrupt = vi.fn()
    const harness = await setup({ onInterrupt })
    harness.ui.showChatLayout()
    harness.ui.setBusy(true)

    harness.press("escape")
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(harness.text("agent-bar")).toContain("ESC again")

    harness.press("escape")
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it("does not treat command-menu escape as an interrupt", async () => {
    const onInterrupt = vi.fn()
    const harness = await setup({
      commands: [{ name: "/new", description: "Start a new session" }],
      onInterrupt,
    })
    harness.ui.showChatLayout()
    harness.ui.setBusy(true)
    harness.setChatInput("/")

    harness.press("escape")

    expect(harness.find("command-menu")).toBeUndefined()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it("suspends and restores the thinking bar around the command menu", async () => {
    const harness = await setup({ commands: [{ name: "/new", description: "Start a new session" }] })
    harness.ui.showChatLayout()
    harness.ui.startThinkingAnimation()

    expect(harness.childIds("root")).toContain("agent-bar")

    harness.setChatInput("/")
    expect(harness.childIds("root")).not.toContain("agent-bar")

    harness.press("escape")
    expect(harness.childIds("root")).toContain("agent-bar")
  })

  it.each([
    ["y", true],
    ["n", false],
    ["escape", false],
  ])("resolves permission prompt key %s as %s", async (key, expected) => {
    const harness = await setup()
    const decision = harness.ui.showPermissionPrompt("Running command: rm -rf build")

    expect(harness.text("permission-label")).toBe("Running command: rm -rf build")
    harness.press(key)

    await expect(decision).resolves.toBe(expected)
    expect(harness.find("permission-prompt")).toBeUndefined()
  })

  it("inserts and removes the update hint without displacing the input", async () => {
    const harness = await setup()

    harness.ui.showUpdateHint()
    expect(harness.text("update-hint")).toContain("otis update")
    expect(harness.childIds("input-area")).toEqual(["update-hint", "input-box"])

    harness.ui.hideUpdateHint()
    expect(harness.find("update-hint")).toBeUndefined()
    expect(harness.childIds("input-area")).toEqual(["input-box"])
  })

  it("combines session and diff stats in the top bar", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()

    harness.ui.setSessionLabel("Refactor parser")
    harness.ui.setDiffStats(12, 3)

    expect(harness.text("session-label")).toContain("Refactor parser")
    expect(harness.text("session-label")).toContain("+12")
    expect(harness.text("session-label")).toContain("−3")
  })
})
