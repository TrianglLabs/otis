import {
  type BoxRenderable,
  fg,
  MouseButton,
  type ScrollBoxRenderable,
  StyledText,
  type TextRenderable,
  t,
} from "@opentui/core"
import type { SubagentStatus, SubagentTrace } from "../../app/subagents.js"
import { colors } from "../theme.js"
import { SelectionPulse, shimmerText } from "./color-pulse.js"
import { formatElapsed } from "./format.js"
import { createPickerRow, type PickerRow, truncatePickerLabel } from "./picker-row.js"
import type { Renderer } from "./types.js"

/** Below this width the panel would squeeze the transcript, so it stays hidden and traces remain click-free. */
export const SUBAGENT_PANEL_MIN_TERMINAL_WIDTH = 96
const TITLE_WIDTH = 28
const STATUS_GLYPHS: Record<SubagentStatus, string> = {
  running: "◇",
  complete: "✓",
  failed: "✗",
  interrupted: "⊘",
}

export function subagentRowId(toolCallId: string) {
  return `subagent-${toolCallId}`
}

export function subagentGlyph(status: SubagentStatus) {
  return STATUS_GLYPHS[status]
}

export function subagentGlyphColor(status: SubagentStatus) {
  if (status === "running") return colors.accent
  if (status === "complete") return colors.green
  if (status === "failed") return colors.pink
  return colors.muted
}

/** Progress line for a run: tool count while running, then tool count and wall-clock time. */
export function subagentSummary(trace: SubagentTrace) {
  const tools = trace.transcript.entries.filter((entry) => entry.kind === "tool").length
  const parts = [`${tools} ${tools === 1 ? "tool" : "tools"}`]
  if (trace.status === "running") parts.push("running")
  else if (trace.durationMs !== undefined) parts.push(formatElapsed(trace.durationMs))
  if (trace.status === "failed") parts.push("failed")
  if (trace.status === "interrupted") parts.push("interrupted")
  return parts.join(" · ")
}

type SubagentPanelOptions = {
  renderer: Renderer
  chatBody: BoxRenderable
  panel: BoxRenderable
  rows: ScrollBoxRenderable
  footer: TextRenderable
  onSelect: (toolCallId: string) => void
}

/** Lists the session's delegated runs beside the transcript, shimmering titles while they work. */
export class SubagentPanel {
  readonly #rows = new Map<string, PickerRow>()
  readonly #pulse: SelectionPulse
  #traces: readonly SubagentTrace[] = []
  #selectedId: string | undefined
  #preferredVisible = true
  #mounted = false

  constructor(private readonly options: SubagentPanelOptions) {
    this.#pulse = new SelectionPulse(options.renderer, (elapsedMs) => this.paint(elapsedMs))
    options.renderer.on("resize", () => this.layout())
  }

  get mounted() {
    return this.#mounted
  }

  render(traces: readonly SubagentTrace[]) {
    this.#traces = traces
    this.syncRows()
    this.layout()
    if (traces.some((trace) => trace.status === "running")) this.#pulse.start()
    else this.#pulse.stop()
    this.paint(this.#pulse.elapsed())
    this.options.renderer.requestRender()
  }

  /** Honors the `/settings subagents` preference. Width and empty-session rules still apply when shown. */
  setVisible(visible: boolean) {
    if (this.#preferredVisible === visible) return
    this.#preferredVisible = visible
    this.layout()
  }

  /** Highlights the run whose trace is open; `undefined` when the transcript is showing. */
  select(toolCallId: string | undefined) {
    this.#selectedId = toolCallId
    this.options.footer.content = toolCallId ? "[esc] back to chat" : "click a run to inspect"
    this.paint(this.#pulse.elapsed())
    this.options.renderer.requestRender()
  }

  refreshTheme() {
    for (const row of this.#rows.values()) {
      row.box.backgroundColor = colors.surface
      row.title.bg = colors.surface
      row.meta.bg = colors.surface
    }
    this.paint(this.#pulse.elapsed())
  }

  /** Mounts the panel only while there is something to list and the terminal is wide enough for two columns. */
  layout() {
    const shouldMount =
      this.#preferredVisible &&
      this.#traces.length > 0 &&
      this.options.renderer.terminalWidth >= SUBAGENT_PANEL_MIN_TERMINAL_WIDTH
    if (shouldMount === this.#mounted) return
    if (shouldMount) this.options.chatBody.add(this.options.panel)
    else this.options.chatBody.remove(this.options.panel.id)
    this.#mounted = shouldMount
    this.options.renderer.requestRender()
  }

  private syncRows() {
    const ids = new Set(this.#traces.map((trace) => trace.toolCallId))
    for (const [id, row] of this.#rows) {
      if (ids.has(id)) continue
      this.options.rows.remove(row.box.id)
      this.#rows.delete(id)
    }
    this.#traces.forEach((trace, index) => {
      if (this.#rows.has(trace.toolCallId)) return
      const row = createPickerRow(this.options.renderer, subagentRowId(trace.toolCallId), { bg: "surface" })
      row.meta.visible = true
      row.box.onMouseDown = (event) => {
        if (event.button !== MouseButton.LEFT) return
        event.preventDefault()
        event.stopPropagation()
        this.options.onSelect(trace.toolCallId)
      }
      row.box.onMouseOver = () => this.options.renderer.setMousePointer("pointer")
      row.box.onMouseOut = () => this.options.renderer.setMousePointer("default")
      this.#rows.set(trace.toolCallId, row)
      this.options.rows.add(row.box, index)
    })
  }

  private paint(elapsedMs: number) {
    for (const trace of this.#traces) {
      const row = this.#rows.get(trace.toolCallId)
      if (!row) continue
      const selected = trace.toolCallId === this.#selectedId
      row.title.content = rowTitle(trace, selected, elapsedMs)
      row.meta.content = `   ${subagentSummary(trace)}`
      row.meta.fg = colors.muted
    }
  }
}

function rowTitle(trace: SubagentTrace, selected: boolean, elapsedMs: number) {
  const title = truncatePickerLabel(trace.title, TITLE_WIDTH)
  const glyph = fg(subagentGlyphColor(trace.status))(subagentGlyph(trace.status))
  const chunks = [...t`${selected ? fg(colors.accent)("›") : " "} ${glyph} `.chunks]
  if (trace.status === "running") chunks.push(...shimmerText(title, elapsedMs, colors.text).chunks)
  else chunks.push(...t`${fg(selected ? colors.accent : colors.text)(title)}`.chunks)
  return new StyledText(chunks)
}
