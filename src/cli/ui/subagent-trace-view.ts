import { BoxRenderable, fg, type ScrollBoxRenderable, TextRenderable, type TreeSitterClient, t } from "@opentui/core"
import type { SubagentTrace } from "../subagents.js"
import { colors } from "../theme.js"
import { createMessagesView, createScrollbarOptions } from "./panels.js"
import { subagentGlyph, subagentGlyphColor, subagentSummary } from "./subagent-panel.js"
import { TranscriptView } from "./transcript-view.js"
import type { Renderer } from "./types.js"

/**
 * Shows one delegated run's full transcript in place of the conversation. The trace is rendered by the same
 * `TranscriptView` as the main transcript, so reasoning, text, tool cards, and diffs behave identically.
 */
export class SubagentTraceView {
  readonly root: BoxRenderable
  readonly #header: TextRenderable
  readonly #view: TranscriptView
  readonly #messages: ScrollBoxRenderable
  #trace: SubagentTrace | undefined

  constructor(
    private readonly renderer: Renderer,
    treeSitterClient?: TreeSitterClient,
    thinkingVisible = false,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "subagent-trace",
      flexDirection: "column",
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 1,
      backgroundColor: colors.background,
    })
    this.#header = new TextRenderable(renderer, {
      id: "subagent-trace-header",
      content: " ",
      width: "100%",
      flexShrink: 0,
      paddingLeft: 1,
      marginBottom: 1,
      fg: colors.text,
      bg: colors.background,
      truncate: true,
      selectable: false,
    })
    this.#messages = createMessagesView(renderer, "subagent-messages")
    this.root.add(this.#header)
    this.root.add(this.#messages)
    this.#view = new TranscriptView(renderer, this.#messages, treeSitterClient, thinkingVisible)
  }

  get trace() {
    return this.#trace
  }

  /** Renders the trace; the caller mounts `root` where the conversation normally sits. */
  open(trace: SubagentTrace) {
    this.#trace = trace
    this.paint(trace, { scrollToBottom: true })
  }

  close() {
    this.#trace = undefined
    this.renderer.requestRender()
  }

  /** Re-renders the open trace when its run has progressed; closes when the run is no longer in the session. */
  update(traces: readonly SubagentTrace[]) {
    if (!this.#trace) return
    const current = traces.find((trace) => trace.toolCallId === this.#trace?.toolCallId)
    if (!current) {
      this.#trace = undefined
      return
    }
    this.#trace = current
    this.paint(current)
  }

  refreshTheme() {
    this.#header.bg = colors.background
    this.#messages.verticalScrollbarOptions = createScrollbarOptions()
    this.#view.refreshTheme()
    if (this.#trace) this.paint(this.#trace)
  }

  setThinkingVisible(visible: boolean) {
    this.#view.setThinkingVisible(visible)
  }

  private paint(trace: SubagentTrace, options: { scrollToBottom?: boolean } = {}) {
    const glyph = fg(subagentGlyphColor(trace.status))(subagentGlyph(trace.status))
    this.#header.content = t`${glyph} ${fg(colors.text)(trace.title)} ${fg(colors.muted)(`· ${subagentSummary(trace)}`)}`
    this.#view.render(trace.transcript.entries, options)
  }
}
