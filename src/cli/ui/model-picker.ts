import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { pairEngineLabel } from "../../inference/pair.js"
import {
  formatContextWindow,
  isSelectablePickerItem,
  type ModelPickerChoice,
  type ModelPickerItem,
  type ModelPickerStatus,
} from "../../inference/picker-catalog.js"
import { filterModelPickerItems } from "../../inference/picker-filter.js"
import { isHostedProvider } from "../../inference/types.js"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import { CPU_OFFLOAD_MODEL_MARK, FAST_MODE_LABEL, RECOMMENDED_MODEL_MARK } from "./format.js"
import {
  type PickerRow,
  type PickerRowSpec,
  paintPickerOutline,
  pickerRowBoxId,
  stylePickerRow,
  syncPickerRows,
  truncatePickerLabel,
} from "./picker-row.js"
import { type Renderer, stopKey, type UIKey } from "./types.js"

export const MODEL_PICKER_HINT = "[↑↓] move · type to search · * recommended · ◐ partly on CPU"

/** The catalog list with a type-to-search filter; the panel footer shows the query. */
export class ModelPicker {
  readonly #rows: PickerRow[] = []
  #items: ModelPickerItem[] = []
  /** The rows the query leaves, which the selection indexes. */
  #visible: ModelPickerItem[] = []
  #query = ""
  #selectedIndex = 0
  readonly #pulse: SelectionPulse

  constructor(
    private readonly renderer: Renderer,
    private readonly container: ScrollBoxRenderable,
    private readonly footer?: TextRenderable,
  ) {
    this.#pulse = new SelectionPulse(renderer, (elapsed) => this.paintPulse(elapsed))
  }

  setItems(items: ModelPickerItem[]) {
    this.#items = items
    this.#applyQuery()
    this.#pulse.start()
  }

  setItemStatus(id: string, status: ModelPickerStatus | undefined) {
    const item = this.#items.find(
      (candidate) => candidate.kind === "model" && modelPickerKey(candidate) === id,
    )
    if (!item || item.kind === "header" || isHostedProvider(item.provider)) return
    item.status = status
    this.render()
    this.renderer.requestRender()
  }

  /** The picker is leaving the screen; it reopens unfiltered. */
  stop() {
    this.#pulse.stop()
    this.#query = ""
  }

  handleKey(key: UIKey, actions: { close: () => void; select: (item: ModelPickerItem) => void }) {
    if (key.name === "escape") {
      stopKey(key)
      // A search in progress is dismissed first; the next Escape closes the picker.
      if (this.#query) this.#setQuery("")
      else actions.close()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      stopKey(key)
      const rows = this.#visible
      if (rows.length === 0) return true
      const delta = key.name === "up" ? -1 : 1
      let next = this.#selectedIndex
      for (let step = 0; step < rows.length; step += 1) {
        next = (next + delta + rows.length) % rows.length
        if (rows[next]?.kind !== "header") break
      }
      this.#selectedIndex = next
      this.render()
      this.scrollToSelection()
      this.renderer.requestRender()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      stopKey(key)
      const selected = this.#visible[this.#selectedIndex]
      if (isSelectablePickerItem(selected)) actions.select(selected)
      return true
    }
    if (key.name === "backspace" || key.name === "delete") {
      stopKey(key)
      this.#setQuery(this.#query.slice(0, -1))
      return true
    }
    // One printable character (space included; escape sequences are longer) extends the search.
    const typed = key.sequence ?? ""
    if (/^\P{Cc}$/u.test(typed) && !key.ctrl && !key.meta) {
      stopKey(key)
      this.#setQuery(this.#query + typed)
      return true
    }
    return false
  }

  #setQuery(query: string) {
    if (query === this.#query) return
    this.#query = query
    this.#applyQuery()
    this.renderer.requestRender()
  }

  /** Filters the rows and keeps the selected row when it survives, else selects the active one. */
  #applyQuery() {
    const selected = this.#visible[this.#selectedIndex]
    const keepKey = selected && selected.kind !== "header" ? modelPickerKey(selected) : undefined
    const rows = filterModelPickerItems(this.#items, this.#query)
    this.#visible = rows
    const keptIndex = keepKey
      ? rows.findIndex((item) => item.kind !== "header" && modelPickerKey(item) === keepKey)
      : -1
    const activeIndex = rows.findIndex((item) => item.kind !== "header" && item.active)
    this.#selectedIndex =
      keptIndex >= 0 ? keptIndex : activeIndex >= 0 ? activeIndex : firstSelectableIndex(rows)
    if (this.footer)
      this.footer.content = this.#query ? `Search: ${this.#query}` : MODEL_PICKER_HINT
    this.render()
    this.scrollToSelection()
  }

  private render() {
    syncPickerRows(
      this.renderer,
      this.container,
      this.#rows,
      this.rowData(),
      "model-row",
      (spec) => ({ outline: spec.header !== true }),
      this.#pulse.elapsed(),
    )
  }

  private rowData(): PickerRowSpec[] {
    if (this.#visible.length === 0) {
      const title = this.#query ? "No models match" : "No models found"
      return [{ title, fg: colors.muted, selected: false }]
    }
    return this.#visible.map((item, index) => {
      if (item.kind === "header") {
        return {
          title: item.displayName.toUpperCase(),
          fg: colors.muted,
          selected: false,
          header: true,
        }
      }
      const disabled = item.available === false
      const suffixes = modelNameSuffixes(item)
      const marker =
        item.provider === "local"
          ? `${item.recommended ? ` ${RECOMMENDED_MODEL_MARK}` : ""}${item.cpuOffload ? ` ${CPU_OFFLOAD_MODEL_MARK}` : ""}`
          : ""
      const maximum = suffixes.length > 0 ? 20 : 30
      return {
        title: `${truncatePickerLabel(item.displayName, maximum - marker.length)}${marker}`,
        ...(suffixes.length > 0 ? { suffixes } : {}),
        meta: modelMeta(item),
        fg: disabled ? colors.muted : item.active ? colors.accent : colors.text,
        selected: index === this.#selectedIndex,
        disabled,
      }
    })
  }

  private paintPulse(elapsedMs: number) {
    this.rowData().forEach((spec, index) => {
      const row = this.#rows[index]
      if (spec.suffixes?.some((suffix) => suffix.shimmer)) stylePickerRow(row, spec, elapsedMs)
      else if (row.outline && spec.selected && spec.header !== true)
        paintPickerOutline(row, true, elapsedMs)
    })
  }

  private scrollToSelection() {
    if (this.#visible[0]?.kind === "header" && this.#selectedIndex === 1) {
      this.container.scrollTo(0)
      return
    }
    const headerIndex = this.#selectedIndex - 1
    if (this.#visible[headerIndex]?.kind === "header") {
      this.container.scrollChildIntoView(pickerRowBoxId(`model-row-${headerIndex}`))
    }
    this.container.scrollChildIntoView(pickerRowBoxId(`model-row-${this.#selectedIndex}`))
  }
}

function modelNameSuffixes(item: ModelPickerChoice) {
  const suffixes: Array<{ text: string; fg?: string; shimmer?: boolean }> = []
  const status = item.status
    ? { text: item.status.label, shimmer: item.status.kind === "progress" }
    : undefined
  if (item.provider === "pair")
    suffixes.push({ text: pairEngineLabel(item.engine), fg: colors.muted })
  if (item.provider === "omlx" || item.provider === "pair") {
    if (status) suffixes.push(status)
  } else if (item.provider === "local") {
    if (status) suffixes.push(status)
    else if (item.downloaded) suffixes.push({ text: "Downloaded", fg: colors.muted })
  }
  return suffixes
}

function modelMeta(item: ModelPickerChoice) {
  if (item.provider === "omlx" && item.availabilityLabel) return item.availabilityLabel
  if (item.provider === "local") {
    return `${item.availabilityLabel} · ${item.supportsImageInput ? "Vision" : "Text"}`
  }
  if (item.provider === "pair") {
    const context = item.nativeContextLength
      ? `${formatContextWindow(item.nativeContextLength)} model max`
      : "Context unavailable"
    const quantization = item.quantization ?? "Quant unavailable"
    return `${context} · ${quantization} · ${item.supportsImageInput ? "Vision" : "Text"}`
  }
  const parts: string[] = []
  if (item.contextLength) parts.push(formatContextWindow(item.contextLength))
  parts.push(item.supportsImageInput ? "Vision" : "Text")
  if (item.provider === "fireworks" && item.fastId) parts.push(FAST_MODE_LABEL)
  return parts.join(" · ")
}

function modelPickerKey(item: ModelPickerChoice) {
  return "selectionKey" in item ? item.selectionKey : item.id
}

function firstSelectableIndex(items: readonly ModelPickerItem[]) {
  const index = items.findIndex((item) => isSelectablePickerItem(item))
  if (index >= 0) return index
  return Math.max(
    0,
    items.findIndex((item) => item.kind !== "header"),
  )
}
