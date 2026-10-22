import {
  type BoxRenderable,
  RGBA,
  type StyledText,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { describe, expect, it, vi } from "vitest"
import { createChatUI } from "../../src/cli/chat-ui.js"
import { colors } from "../../src/cli/theme.js"
import {
  CHAT_KEY_HINT,
  CHAT_KEY_HINT_DURATION_MS,
  contextUsage,
  formatContextUsage,
} from "../../src/cli/ui/format.js"
import { ACTIVITY_WIDTH } from "../../src/cli/ui/panels.js"
import type { LocalStats } from "../../src/local/stats.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

const ZERO_STATS: LocalStats = {
  streak: 0,
  totalTokens: 0,
  sessionCount: 0,
  avgTokensPerSession: 0,
  avgSessionSeconds: 0,
  activeDays: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedPromptTokens: 0,
  cacheReportedPromptTokens: 0,
  todayTokens: 0,
  recentActivity: [],
  modelUsage: {},
  achievements: {},
}
const sampleStats = {
  ...ZERO_STATS,
  streak: 7,
  totalTokens: 1_250_000,
  sessionCount: 12,
  avgTokensPerSession: 24_600,
  avgSessionSeconds: 420,
}

const sampleActivity = Array.from({ length: 28 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, "0")}`,
  tokens: index % 5 === 0 ? 0 : index * 1_000,
}))

/** Each card counts for 900ms, staggered 70ms apart, on a 50ms frame. */
function settleStats() {
  vi.advanceTimersByTime(900 + 70 * 3 + 50)
}

describe("chat UI status and prompts", () => {
  const setup = useChatHarness()

  it("shows the selected model at home and the model with workspace in chat", async () => {
    const harness = await setup({ modelLabel: "Tool Model" })

    expect(harness.text("input-hint")).toBe("")
    expect(harness.text("welcome-model")).toBe("Tool Model")

    harness.ui.showChatLayout()
    expect(harness.text("input-hint")).toBe(" Tool Model · ~/work/otis ")
    const inputBox = harness.get<BoxRenderable>("input-box")
    expect(inputBox.title).toBeUndefined()
    expect(inputBox.bottomTitle).toBeUndefined()

    harness.ui.setModelLabel("Replacement")
    expect(harness.text("input-hint")).toBe(" Replacement · ~/work/otis ")
    harness.ui.setThinkingVisible(true)
    expect(harness.text("input-hint")).toBe(" Replacement · ~/work/otis ")
    harness.ui.showHomeLayout()
    expect(harness.text("input-hint")).toBe("")
    expect(harness.text("welcome-model")).toBe("Replacement")
    const footer = harness.get<BoxRenderable>("welcome-footer")
    const model = harness.get<TextRenderable>("welcome-model")
    const quit = harness.get<TextRenderable>("welcome-quit")
    await harness.renderOnce()
    expect(model.x).toBe(footer.x)
    expect(quit.x + quit.width).toBe(footer.x + footer.width)
    expect(model.y).toBe(quit.y)
  })

  it("briefly reveals the keyboard controls when the chat hint is clicked", async () => {
    // Mouse simulation needs real time to pass; the hint timer is still driven explicitly below.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const harness = await setup({ modelLabel: "Tool Model" })
    harness.ui.showChatLayout()
    await harness.renderOnce()
    const hint = harness.get<TextRenderable>("input-hint")

    await harness.mockMouse.click(hint.x, hint.y)
    expect(harness.text("input-hint")).toBe(CHAT_KEY_HINT)
    expect(hint.fg.equals(RGBA.fromHex(colors.accent))).toBe(true)

    // A model change while the hint is showing updates what the hint reverts to, not what is on
    // screen.
    harness.ui.setModelLabel("Replacement")
    expect(harness.text("input-hint")).toBe(CHAT_KEY_HINT)

    vi.advanceTimersByTime(CHAT_KEY_HINT_DURATION_MS)
    expect(harness.text("input-hint")).toBe(" Replacement · ~/work/otis ")
    expect(hint.fg.equals(RGBA.fromHex(colors.muted))).toBe(true)
  })

  it("ignores clicks on the home hint", async () => {
    const harness = await setup({ modelLabel: "Tool Model" })
    await harness.renderOnce()
    const hint = harness.get<TextRenderable>("input-hint")

    await harness.mockMouse.click(hint.x, hint.y)
    expect(harness.text("input-hint")).toBe("")
  })

  it("formats local stats and keeps labeled zero values", async () => {
    vi.useFakeTimers()
    const harness = await setup()

    harness.ui.setStats(sampleStats)
    settleStats()

    expect(harness.text("welcome-stat-value-0")).toBe("7")
    expect(harness.text("welcome-stat-label-0")).toBe("day streak")
    expect(harness.text("welcome-stat-value-1")).toBe("1.3M")
    expect(harness.text("welcome-stat-value-2")).toBe("25K")
    expect(harness.text("welcome-stat-value-3")).toBe("7M")

    harness.ui.setStats({
      ...ZERO_STATS,
      streak: 0,
      totalTokens: 0,
      sessionCount: 0,
      avgTokensPerSession: 0,
      avgSessionSeconds: 0,
    })
    expect(harness.text("welcome-stat-value-0")).toBe("0")
    expect(harness.text("welcome-stat-label-0")).toBe("day streak")
    expect(harness.text("welcome-stat-value-1")).toBe("0")
    expect(harness.text("welcome-stat-label-1")).toBe("total tokens")
    expect(harness.text("welcome-stat-value-2")).toBe("0")
    expect(harness.text("welcome-stat-label-2")).toBe("tokens/session")
    expect(harness.text("welcome-stat-value-3")).toBe("0S")
    expect(harness.text("welcome-stat-label-3")).toBe("time/session")
  })

  it("formats billion-scale all-time usage in billions", async () => {
    vi.useFakeTimers()
    const harness = await setup()

    harness.ui.setStats({ ...sampleStats, totalTokens: 1_211_800_000 })
    settleStats()

    expect(harness.text("welcome-stat-value-1")).toBe("1.2B")
  })

  it("eases the count-up so early frames cover most of the distance", async () => {
    vi.useFakeTimers()
    const harness = await setup()

    harness.ui.setStats(sampleStats)
    // Halfway through the first card's 900ms count, ease-out has covered 87.5% of 7.
    vi.advanceTimersByTime(450)
    expect(harness.text("welcome-stat-value-0")).toBe("6")
    expect(harness.text("welcome-stat-value-1")).not.toBe("0")
    expect(harness.text("welcome-stat-value-1")).not.toBe("1.3M")

    settleStats()
    expect(harness.text("welcome-stat-value-0")).toBe("7")
    expect(harness.text("welcome-stat-value-1")).toBe("1.3M")
  })

  it("keeps the slash menu open while home stats finish animating", async () => {
    vi.useFakeTimers()
    const harness = await setup({
      commands: [
        { name: "/model", description: "Choose a model" },
        { name: "/settings", description: "Configure Otis" },
      ],
    })

    harness.ui.setStats(sampleStats)
    harness.setChatInput("/")
    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box", "command-row-1-box"])

    settleStats()
    await harness.renderOnce()

    expect(harness.childIds("command-menu")).toEqual(["command-row-0-box", "command-row-1-box"])
    expect(harness.text("command-row-0")).toBe("› /model")
  })

  it("replays the count-up when returning home", async () => {
    vi.useFakeTimers()
    const harness = await setup()
    harness.ui.setStats(sampleStats)
    settleStats()
    harness.ui.showChatLayout()

    harness.ui.showHomeLayout()
    expect(harness.text("welcome-stat-value-0")).toBe("0")
    settleStats()
    expect(harness.text("welcome-stat-value-0")).toBe("7")
  })

  it("shows transient status feedback and restores the model hint", async () => {
    vi.useFakeTimers()
    const harness = await setup({ modelLabel: "Tool Model" })
    harness.ui.showChatLayout()

    harness.ui.showTransientHint(" Thinking traces shown ")
    expect(harness.text("input-hint")).toBe(" Thinking traces shown ")

    vi.advanceTimersByTime(1_500)
    expect(harness.text("input-hint")).toBe(" Tool Model · ~/work/otis ")
  })

  it("spreads the metrics across the chart and keeps the block seven rows tall", async () => {
    vi.useFakeTimers()
    const harness = await setup()
    harness.ui.setStats({
      ...ZERO_STATS,
      streak: 12,
      totalTokens: 1_234_567,
      sessionCount: 40,
      avgTokensPerSession: 983,
      avgSessionSeconds: 15_082,
      todayTokens: 4_200,
      recentActivity: sampleActivity,
    })
    settleStats()
    await harness.renderOnce()

    const block = harness.get<BoxRenderable>("welcome-stats-row")
    const chart = harness.get<TextRenderable>("welcome-stats-chart")
    const cards = [0, 1, 2, 3].map((index) => harness.get<BoxRenderable>(`welcome-stat-${index}`))
    const metrics = harness.get<BoxRenderable>("welcome-stats-metrics")
    expect(block.width).toBe(metrics.width)
    expect(block.height).toBe(7)
    expect(chart.width).toBe(ACTIVITY_WIDTH)
    expect(chart.height).toBe(3)
    expect(chart.x - block.x).toBe(Math.floor((block.width - ACTIVITY_WIDTH) / 2))
    expect(cards[0].x).toBe(block.x)
    expect(cards[3].x + cards[3].width).toBe(block.x + block.width)
    for (let index = 1; index < cards.length; index += 1) {
      const previous = cards[index - 1]
      const divider = harness.get<TextRenderable>(`welcome-stat-divider-${index}`)
      expect(divider.height).toBe(2)
      expect(divider.fg.equals(RGBA.fromHex(colors.border))).toBe(true)
      expect(divider.x).toBe(previous.x + previous.width + 1)
      expect(cards[index].x).toBe(divider.x + 2)
    }
    expect(harness.text("welcome-stats-range")).toMatch(/^\w+ \d+ – \w+ \d+$/)
    expect(harness.text("welcome-stats-today")).toBe("today 4K")
    const rows = (chart.content as StyledText).chunks
      .map((chunk) => chunk.text)
      .join("")
      .split("\n")
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.length === ACTIVITY_WIDTH)).toBe(true)
    expect(rows[2]).toMatch(/^([\u2581-\u2588] )+[\u2581-\u2588]$/)
  })

  it("hides stats until configured and reveals labeled zeros after setup", async () => {
    const harness = await setup({ configured: false })

    expect(harness.find("welcome-stats-row")).toBeUndefined()
    harness.ui.setConfigured()

    expect(harness.text("welcome-stat-value-0")).toBe("0")
    expect(harness.text("welcome-stat-label-3")).toBe("time/session")
  })

  it("keeps home screen elements at full size when the input grows tall", async () => {
    // Needs a 24-row terminal to force the overflow; the shared harness is 30 rows.
    const testRenderer = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
    const ui = createChatUI(testRenderer.renderer, {
      contextLabel: formatContextUsage(contextUsage(0, 1)),
      modelLabel: "Model: test",
      modeLabel: "› auto",
      sessionLabel: "default",
      workspaceLabel: "~/work/otis",
      onSubmit: () => {},
    })
    try {
      vi.useFakeTimers()
      ui.setStats({
        ...ZERO_STATS,
        streak: 12,
        totalTokens: 1_234_567,
        sessionCount: 40,
        avgTokensPerSession: 983,
        avgSessionSeconds: 15_082,
      })
      settleStats()
      const input = testRenderer.renderer.root.findDescendantById(
        "otis-input",
      ) as TextareaRenderable
      input.setText(
        Array.from({ length: 12 }, (_, index) => `line ${index + 1} of some long text`).join("\n"),
      )
      await testRenderer.renderOnce()

      const find = (id: string) => {
        const renderable = testRenderer.renderer.root.findDescendantById(id)
        if (!renderable) throw new Error(`Renderable not found: ${id}`)
        return renderable
      }
      expect(find("welcome-brand").height).toBe(10)
      expect(find("welcome-stats-row").height).toBe(7)
      expect(find("welcome-stats-chart").height).toBe(3)

      const frame = testRenderer.captureCharFrame()
      expect(frame).toContain("1.2M")
      expect(frame).toContain("total tokens")
      expect(frame).toContain("Model: test")
      expect(frame).toContain("/ for commands")
    } finally {
      testRenderer.renderer.destroy()
    }
  })

  it("keeps home content vertically centered when everything fits", async () => {
    const testRenderer = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true })
    const ui = createChatUI(testRenderer.renderer, {
      contextLabel: formatContextUsage(contextUsage(0, 1)),
      modelLabel: "Model: test",
      modeLabel: "› auto",
      sessionLabel: "default",
      workspaceLabel: "~/work/otis",
      onSubmit: () => {},
    })
    try {
      vi.useFakeTimers()
      ui.setStats({
        ...ZERO_STATS,
        streak: 12,
        totalTokens: 1_234_567,
        sessionCount: 40,
        avgTokensPerSession: 983,
        avgSessionSeconds: 15_082,
      })
      settleStats()
      await testRenderer.renderOnce()

      const find = (id: string) => {
        const renderable = testRenderer.renderer.root.findDescendantById(id)
        if (!renderable) throw new Error(`Renderable not found: ${id}`)
        return renderable
      }
      const welcome = find("welcome")
      const brand = find("welcome-brand")
      const statsRow = find("welcome-stats-row")
      const panel = find("welcome-panel")

      expect(statsRow.y - (brand.y + brand.height)).toBe(3)
      expect(panel.y - (statsRow.y + statsRow.height)).toBe(2)
      const topSpace = brand.y - welcome.y
      const bottomSpace = welcome.y + welcome.height - (panel.y + panel.height)
      expect(Math.abs(topSpace - bottomSpace)).toBeLessThanOrEqual(1)
    } finally {
      testRenderer.renderer.destroy()
    }
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

  it("quits on Ctrl+C instead of interrupting the turn", async () => {
    const onInterrupt = vi.fn()
    const onQuit = vi.fn()
    const harness = await setup({ onInterrupt, onQuit })
    harness.ui.showChatLayout()
    harness.ui.setBusy(true)

    harness.pressCtrlC()

    expect(onQuit).toHaveBeenCalledOnce()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it("quits on Ctrl+C from the home screen, setup, and model picker", async () => {
    const onQuit = vi.fn()
    const harness = await setup({
      configured: false,
      onQuit,
      onCloseModelPicker: vi.fn(),
    })

    harness.pressCtrlC()
    expect(onQuit).toHaveBeenCalledOnce()

    harness.ui.showSetupInput("", "choice", "fireworks")
    harness.pressCtrlC()
    expect(onQuit).toHaveBeenCalledTimes(2)

    harness.ui.showModelPicker([
      {
        kind: "model",
        provider: "fireworks",
        id: "accounts/fireworks/models/tool-model",
        displayName: "Tool Model",
        contextLength: 131_072,
        supportsImageInput: false,
        available: true,
        active: false,
      },
    ])
    harness.pressCtrlC()
    expect(onQuit).toHaveBeenCalledTimes(3)
  })

  it("centers a THINKING label in the wave only while the model is reasoning", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    // Force a layout pass so the bar renders at its real width.
    await harness.renderOnce()
    harness.ui.startBusyIndicator()

    // Working: the wave fills the bar with no label.
    const working = harness.text("agent-bar")
    expect(working).not.toContain("THINKING")
    expect(working.trim().length).toBeGreaterThan(0)

    harness.ui.setAgentPhase("thinking")
    const thinking = harness.text("agent-bar")
    const label = " THINKING "
    const start = Math.floor((thinking.length - label.length) / 2)
    expect(thinking.indexOf(label)).toBe(start)
    // The wave keeps animating on both sides of the label.
    expect(thinking.slice(0, start).trim().length).toBeGreaterThan(0)
    expect(thinking.slice(start + label.length).trim().length).toBeGreaterThan(0)

    harness.ui.setAgentPhase("working")
    expect(harness.text("agent-bar")).not.toContain("THINKING")
    expect(harness.childIds("root")).toContain("agent-bar")
  })

  it("drops the thinking label when a new busy period starts", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    harness.ui.startBusyIndicator()
    harness.ui.setAgentPhase("thinking")
    harness.ui.stopBusyIndicator()

    harness.ui.startBusyIndicator()
    expect(harness.text("agent-bar")).not.toContain("THINKING")
  })

  it("keeps the busy bar hidden before the first busy period", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()

    expect(harness.find("agent-bar")).toBeUndefined()
  })

  it("suspends and restores the busy bar around the command menu", async () => {
    const harness = await setup({
      commands: [{ name: "/new", description: "Start a new session" }],
    })
    harness.ui.showChatLayout()
    harness.ui.startBusyIndicator()

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

  it("dismisses an open permission prompt as denied", async () => {
    const harness = await setup()
    const decision = harness.ui.showPermissionPrompt("Running command: ls")
    harness.ui.hidePermissionPrompt()
    await expect(decision).resolves.toBe(false)
    expect(harness.find("permission-prompt")).toBeUndefined()
  })

  it("suspends the busy wave while a permission prompt is visible", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    harness.ui.startBusyIndicator()
    expect(harness.childIds("root")).toContain("agent-bar")

    const decision = harness.ui.showPermissionPrompt("Running command: bun test")
    expect(harness.childIds("root")).not.toContain("agent-bar")

    harness.press("y")
    await expect(decision).resolves.toBe(true)
    expect(harness.childIds("root")).toContain("agent-bar")
  })

  it("shows the update hint below the command helper", async () => {
    const harness = await setup()

    harness.ui.showUpdateHint()
    expect(harness.text("update-hint")).toContain("otis update")
    expect(harness.childIds("welcome-panel")).toEqual([
      "input-area",
      "welcome-footer",
      "update-hint",
    ])
    expect(harness.childIds("input-area")).toEqual(["input-box"])

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

  it("keeps the session title centered after the context meter grows", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    harness.ui.setSessionLabel("Refactor parser")
    harness.ui.setContextLabel(formatContextUsage(contextUsage(250_000, 250_000)))
    await harness.renderOnce()

    const bar = harness.get<BoxRenderable>("top-bar")
    const session = harness.get<TextRenderable>("session-label")
    const brand = harness.get<TextRenderable>("title-bar")
    const context = harness.get<TextRenderable>("context-label")
    const barCenter = bar.x + bar.width / 2
    const sessionCenter = session.x + session.width / 2
    expect(brand.x + brand.width).toBeLessThanOrEqual(session.x)
    expect(session.x + session.width).toBeLessThanOrEqual(context.x)
    expect(Math.abs(sessionCenter - barCenter)).toBeLessThanOrEqual(2)
  })

  it("truncates the session title instead of covering the context meter", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    harness.ui.setSessionLabel("A very long session title that should not cover the context meter")
    harness.resize(48, 24)
    await harness.renderOnce()

    const brand = harness.get<TextRenderable>("title-bar")
    const session = harness.get<TextRenderable>("session-label")
    const context = harness.get<TextRenderable>("context-label")
    expect(brand.x + brand.width).toBeLessThanOrEqual(session.x)
    expect(session.x + session.width).toBeLessThanOrEqual(context.x)
    expect(session.width).toBeLessThan(session.plainText.length)

    const topLine = harness
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("OTIS"))
    expect(topLine).toContain("OTIS")
    expect(topLine).toContain(formatContextUsage(contextUsage(0, 1)))
    expect(topLine).toContain("...")
    expect(topLine).not.toContain(
      "A very long session title that should not cover the context meter",
    )
  })
})
