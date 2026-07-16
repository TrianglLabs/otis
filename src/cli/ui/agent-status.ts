import type { BoxRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { ESC_INTERRUPT_HINT, renderThinkingStatus } from "./format.js"
import type { Renderer } from "./types.js"

const THINKING_FRAME_INTERVAL_MS = 120
const ESC_INTERRUPT_WINDOW_MS = 3000
const COPY_HINT_DURATION_MS = 1500

type AgentStatusOptions = {
  renderer: Renderer
  root: BoxRenderable
  inputArea: BoxRenderable
  agentBar: TextRenderable
  inputHint: TextRenderable
  isWelcomeVisible: () => boolean
  isCommandMenuVisible: () => boolean
  onInterrupt?: () => void
}

export class AgentStatus {
  private thinkingFrame = 0
  private barVisible = false
  private thinkingTimer: NodeJS.Timeout | undefined
  private barColor = colors.accent
  private lastEscapeAt = 0
  private interruptVisible = false
  private copyHintTimer: NodeJS.Timeout | undefined
  private idleInputHint = ESC_INTERRUPT_HINT

  constructor(private readonly options: AgentStatusOptions) {}

  setContextColor(color: string) {
    this.barColor = color === colors.muted ? colors.accent : color
    if (this.barVisible) this.renderBar()
  }

  startThinking() {
    if (this.thinkingTimer) return
    this.thinkingFrame = 0
    this.showBar()
    this.thinkingTimer = setInterval(() => {
      this.thinkingFrame += 1
      this.renderBar()
    }, THINKING_FRAME_INTERVAL_MS)
    this.renderBar()
  }

  stopThinking() {
    if (this.thinkingTimer) clearInterval(this.thinkingTimer)
    this.thinkingTimer = undefined
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
    if (this.copyHintTimer) return
    this.options.inputHint.content = content
    this.options.inputHint.fg = colors.muted
    this.options.renderer.requestRender()
  }

  showCopyHint() {
    if (this.interruptVisible) return
    if (this.copyHintTimer) clearTimeout(this.copyHintTimer)
    this.options.inputHint.content = " Copied! "
    this.options.inputHint.fg = colors.accent
    this.options.renderer.requestRender()
    this.copyHintTimer = setTimeout(() => {
      this.copyHintTimer = undefined
      this.options.inputHint.content = this.idleInputHint
      this.options.inputHint.fg = colors.muted
      this.options.renderer.requestRender()
    }, COPY_HINT_DURATION_MS)
    this.copyHintTimer.unref?.()
  }

  suspendForOverlay() {
    if (!this.barVisible) return
    this.options.root.remove(this.options.agentBar.id)
    this.barVisible = false
  }

  restoreAfterOverlay() {
    if (this.interruptVisible) this.showInterrupt()
    else if (this.thinkingTimer) {
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
    agentBar.content = renderThinkingStatus(this.thinkingFrame, availableWidth)
    agentBar.fg = this.barColor
    renderer.requestRender()
  }

  private showBar() {
    if (this.barVisible || this.options.isWelcomeVisible() || this.options.isCommandMenuVisible()) return
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
    if (!this.thinkingTimer) this.hideBar()
    this.options.renderer.requestRender()
  }
}
