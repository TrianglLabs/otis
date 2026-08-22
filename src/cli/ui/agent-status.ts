import type { BoxRenderable, TextRenderable } from "@opentui/core"
import { colors, type ThemeColors } from "../theme.js"
import { renderBusyWave } from "./busy-wave.js"
import { AGENT_PHASE_LABELS, type AgentPhase, CHAT_INPUT_HINT } from "./format.js"
import type { Renderer } from "./types.js"

const BUSY_FRAME_INTERVAL_MS = 50
const ESC_INTERRUPT_WINDOW_MS = 3000
const TRANSIENT_HINT_DURATION_MS = 1500

type AgentStatusOptions = {
  renderer: Renderer
  root: BoxRenderable
  inputArea: BoxRenderable
  agentBar: TextRenderable
  inputHint: TextRenderable
  isWelcomeVisible: () => boolean
  isOverlayVisible: () => boolean
  onInterrupt?: () => void
}

export class AgentStatus {
  private busyStartedAt = 0
  private barVisible = false
  private busyTimer: NodeJS.Timeout | undefined
  private barColor = colors.accent
  private lastEscapeAt = 0
  private interruptVisible = false
  private transientHintTimer: NodeJS.Timeout | undefined
  private idleInputHint = CHAT_INPUT_HINT
  private phase: AgentPhase = "working"

  constructor(private readonly options: AgentStatusOptions) {}

  setPhase(phase: AgentPhase) {
    if (this.phase === phase) return
    this.phase = phase
    if (this.busyTimer && this.barVisible) this.renderBar()
  }

  setContextColor(color: string) {
    this.barColor = color === colors.muted ? colors.accent : color
    if (this.barVisible) this.renderBar()
  }

  refreshTheme(previous: ThemeColors) {
    const color = Object.entries(previous).find(([, value]) => value === this.barColor)?.[0] as
      | keyof ThemeColors
      | undefined
    if (color) this.barColor = colors[color]
    this.options.agentBar.bg = colors.background
    if (this.barVisible) this.renderBar()
  }

  startBusyIndicator() {
    if (this.busyTimer) return
    this.busyStartedAt = Date.now()
    this.phase = "working"
    this.showBar()
    this.busyTimer = setInterval(() => this.renderBar(), BUSY_FRAME_INTERVAL_MS)
    this.renderBar()
  }

  stopBusyIndicator() {
    if (this.busyTimer) clearInterval(this.busyTimer)
    this.busyTimer = undefined
    this.hideBar()
  }

  handleEscape() {
    const now = Date.now()
    if (now - this.lastEscapeAt < ESC_INTERRUPT_WINDOW_MS) {
      this.lastEscapeAt = 0
      this.hideInterrupt()
      this.options.onInterrupt?.()
      return
    }

    this.lastEscapeAt = now
    this.showInterrupt()
    const timeout = setTimeout(() => {
      if (this.lastEscapeAt > 0 && Date.now() - this.lastEscapeAt >= ESC_INTERRUPT_WINDOW_MS) {
        this.lastEscapeAt = 0
        this.hideInterrupt()
      }
    }, ESC_INTERRUPT_WINDOW_MS)
    timeout.unref?.()
  }

  clearInterrupt() {
    this.lastEscapeAt = 0
    this.hideInterrupt()
  }

  setInputHint(content: string) {
    this.idleInputHint = content
    if (this.transientHintTimer) return
    this.options.inputHint.content = content
    this.options.inputHint.fg = colors.muted
    this.options.renderer.requestRender()
  }

  showCopyHint() {
    this.showTransientHint(" Copied! ")
  }

  showTransientHint(content: string) {
    if (this.interruptVisible) return
    if (this.transientHintTimer) clearTimeout(this.transientHintTimer)
    this.options.inputHint.content = content
    this.options.inputHint.fg = colors.accent
    this.options.renderer.requestRender()
    this.transientHintTimer = setTimeout(() => {
      this.transientHintTimer = undefined
      this.options.inputHint.content = this.idleInputHint
      this.options.inputHint.fg = colors.muted
      this.options.renderer.requestRender()
    }, TRANSIENT_HINT_DURATION_MS)
    this.transientHintTimer.unref?.()
  }

  suspendForOverlay() {
    if (!this.barVisible) return
    this.options.root.remove(this.options.agentBar.id)
    this.barVisible = false
  }

  restoreAfterOverlay() {
    if (this.interruptVisible) this.showInterrupt()
    else if (this.busyTimer) {
      this.showBar()
      this.renderBar()
    }
  }

  hideForHome() {
    if (!this.barVisible) return
    this.options.agentBar.content = ""
    this.options.root.remove(this.options.agentBar.id)
    this.barVisible = false
  }

  private renderBar() {
    if (this.interruptVisible) return
    const { agentBar, renderer, root } = this.options
    const availableWidth = Math.max(agentBar.width, root.width - 2, 1)
    agentBar.content = renderBusyWave(
      Date.now() - this.busyStartedAt,
      availableWidth,
      this.barColor,
      colors.background,
      AGENT_PHASE_LABELS[this.phase],
    )
    agentBar.fg = this.barColor
    renderer.requestRender()
  }

  private showBar() {
    if (this.barVisible || this.options.isWelcomeVisible() || this.options.isOverlayVisible()) return
    this.options.root.insertBefore(this.options.agentBar, this.options.inputArea)
    this.barVisible = true
  }

  private hideBar() {
    if (!this.barVisible || this.interruptVisible) return
    this.options.agentBar.content = ""
    this.options.root.remove(this.options.agentBar.id)
    this.barVisible = false
    this.options.renderer.requestRender()
  }

  private showInterrupt() {
    this.interruptVisible = true
    this.showBar()
    this.options.agentBar.content = " Press ESC again to interrupt "
    this.options.renderer.requestRender()
  }

  private hideInterrupt() {
    if (!this.interruptVisible) return
    this.interruptVisible = false
    if (!this.busyTimer) this.hideBar()
    this.options.renderer.requestRender()
  }
}
