import type { ScrollBoxRenderable } from "@opentui/core"
import { pairEngineLabel } from "../../inference/pair.js"
import {
  formatContextWindow,
  isSelectablePickerItem,
  type ModelPickerChoice,
  type ModelPickerItem,
  type ModelPickerStatus,
} from "../../inference/picker-catalog.js"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import { FAST_MODE_LABEL, RECOMMENDED_MODEL_MARK } from "./format.js"
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

export class ModelPicker {
  readonly #rows: PickerRow[] = []
  #items: ModelPickerItem[] = []
  #selectedIndex = 0
  readonly #pulse: SelectionPulse

  constructor(
    private readonly renderer: Renderer,
    private readonly container: ScrollBoxRenderable,
  ) {
    this.#pulse = new SelectionPulse(renderer, (elapsed) => this.paintPulse(elapsed))
  }

  setItems(items: ModelPickerItem[]) {
    const previous = this.#items[this.#selectedIndex]
    const previousId = previous && previous.kind !== "header" ? modelPickerKey(previous) : undefined
    this.#items = items
    const keptIndex = previousId
      ? items.findIndex((item) => item.kind !== "header" && modelPickerKey(item) === previousId)
      : -1
    const activeIndex = items.findIndex(
      (item) => item.kind !== "header" && "active" in item && item.active,
    )
    this.#selectedIndex =
      keptIndex >= 0 ? keptIndex : activeIndex >= 0 ? activeIndex : firstSelectableIndex(items)
    this.render()
    this.scrollToSelection()
    this.#pulse.start()
  }

  setItemStatus(id: string, status: ModelPickerStatus | undefined) {
    const item = this.#items.find(
      (candidate) => candidate.kind === "model" && modelPickerKey(candidate) === id,
    )
    if (!item || item.kind === "header" || item.provider === "fireworks") return
    item.status = status
    this.render()
    this.renderer.requestRender()
  }

  stop() {
    this.#pulse.stop()
  }

  handleKey(key: UIKey, actions: { close: () => void; select: (item: ModelPickerItem) => void }) {
    if (key.name === "escape") {
      stopKey(key)
      actions.close()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      stopKey(key)
      if (this.#items.length === 0) return true
      const delta = key.name === "up" ? -1 : 1
      let next = this.#selectedIndex
      for (let step = 0; step < this.#items.length; step += 1) {
        next = (next + delta + this.#items.length) % this.#items.length
        if (this.#items[next]?.kind !== "header") break
      }
      this.#selectedIndex = next
      this.render()
      this.scrollToSelection()
      this.renderer.requestRender()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      stopKey(key)
      const selected = this.#items[this.#selectedIndex]
      if (isSelectablePickerItem(selected)) actions.select(selected)
      return true
    }
    return false
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
    if (this.#items.length === 0)
      return [{ title: "No models found", fg: colors.muted, selected: false }]
    return this.#items.map((item, index) => {
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
        item.provider === "local" && item.recommended ? ` ${RECOMMENDED_MODEL_MARK}` : ""
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
    if (this.#items[0]?.kind === "header" && this.#selectedIndex === 1) {
      this.container.scrollTo(0)
      return
    }
    const headerIndex = this.#selectedIndex - 1
    if (this.#items[headerIndex]?.kind === "header") {
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
