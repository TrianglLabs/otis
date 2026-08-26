import type { ScrollBoxRenderable } from "@opentui/core"
import {
  formatContextWindow,
  isSelectablePickerItem,
  type LocalPickerChoice,
  type ModelPickerChoice,
  type ModelPickerItem,
} from "../../inference/picker-catalog.js"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import { FAST_MODEL_LABEL, LOCAL_LOADING_LABEL } from "./format.js"
import {
  createPickerRow,
  type PickerRow,
  type PickerRowSpec,
  paintPickerOutline,
  pickerRowBoxId,
  stylePickerRow,
  truncatePickerLabel,
} from "./picker-row.js"
import type { Renderer } from "./types.js"

type PickerKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

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
    const previousId = this.selectedId()
    this.#items = items
    const keptIndex = previousId ? items.findIndex((item) => item.kind !== "header" && item.id === previousId) : -1
    const activeIndex = items.findIndex((item) => item.kind !== "header" && "active" in item && item.active)
    this.#selectedIndex = keptIndex >= 0 ? keptIndex : activeIndex >= 0 ? activeIndex : firstSelectableIndex(items)
    this.render()
    this.scrollToSelection()
    this.#pulse.start()
  }

  setItemStatus(id: string, status: string | undefined) {
    const item = this.#items.find(
      (candidate): candidate is LocalPickerChoice =>
        candidate.kind === "model" && candidate.provider === "local" && candidate.id === id,
    )
    if (!item) return
    item.statusLabel = status
    this.render()
    this.renderer.requestRender()
  }

  stop() {
    this.#pulse.stop()
  }

  handleKey(key: PickerKey, actions: { close: () => void; select: (item: ModelPickerItem) => void }) {
    if (key.name === "escape") {
      stopKey(key)
      actions.close()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      stopKey(key)
      this.move(key.name === "up" ? -1 : 1)
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

  private move(delta: number) {
    if (this.#items.length === 0) return
    let next = this.#selectedIndex
    for (let step = 0; step < this.#items.length; step += 1) {
      next = (next + delta + this.#items.length) % this.#items.length
      if (this.#items[next]?.kind !== "header") break
    }
    this.#selectedIndex = next
    this.render()
    this.scrollToSelection()
    this.renderer.requestRender()
  }

  private selectedId() {
    const item = this.#items[this.#selectedIndex]
    return item && item.kind !== "header" ? item.id : undefined
  }

  private render() {
    const rows = this.rowData()
    while (this.#rows.length > rows.length) {
      const row = this.#rows.pop()
      if (row) this.container.remove(row.box.id)
    }
    rows.forEach((row, index) => {
      this.setRow(index, row)
    })
  }

  private rowData(): PickerRowSpec[] {
    if (this.#items.length === 0) {
      return [{ title: "No models found", fg: colors.muted, selected: false }]
    }

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
      const suffix = localNameSuffix(item)
      return {
        title: modelTitle(item, suffix !== undefined),
        suffix,
        meta: modelMeta(item),
        fg: disabled ? colors.muted : item.active ? colors.accent : colors.text,
        selected: index === this.#selectedIndex,
        disabled,
      }
    })
  }

  private setRow(index: number, spec: PickerRowSpec) {
    const existing = this.#rows[index]
    if (existing) {
      stylePickerRow(existing, spec, this.#pulse.elapsed())
      return
    }
    const row = createPickerRow(this.renderer, `model-row-${index}`, { outline: spec.header !== true })
    stylePickerRow(row, spec, this.#pulse.elapsed())
    this.#rows.push(row)
    this.container.add(row.box)
  }

  private paintPulse(elapsedMs: number) {
    const specs = this.rowData()
    specs.forEach((spec, index) => {
      const row = this.#rows[index]
      if (!row) return
      if (spec.suffix?.shimmer) {
        stylePickerRow(row, spec, elapsedMs)
        return
      }
      if (row.outline && spec.selected && spec.header !== true) paintPickerOutline(row, true, elapsedMs)
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

function modelTitle(item: ModelPickerChoice, hasSuffix: boolean) {
  return truncatePickerLabel(item.displayName, hasSuffix ? 20 : 30)
}

function localNameSuffix(item: ModelPickerChoice) {
  if (item.provider !== "local") return undefined
  if (item.statusLabel === LOCAL_LOADING_LABEL) return { text: item.statusLabel, shimmer: true }
  if (item.statusLabel) return { text: item.statusLabel }
  if (item.downloaded) return { text: "Downloaded", fg: colors.muted }
  return undefined
}

function modelMeta(item: ModelPickerChoice) {
  if (item.provider === "local") {
    return `${item.availabilityLabel} · ${item.supportsImageInput ? "Vision" : "Text"}`
  }
  const parts: string[] = []
  if (item.contextLength) parts.push(formatContextWindow(item.contextLength))
  parts.push(item.supportsImageInput ? "Vision" : "Text")
  if (item.fastId) parts.push(FAST_MODEL_LABEL)
  return parts.join(" · ")
}

function firstSelectableIndex(items: readonly ModelPickerItem[]) {
  const index = items.findIndex((item) => isSelectablePickerItem(item))
  if (index >= 0) return index
  const fallback = items.findIndex((item) => item.kind !== "header")
  return Math.max(0, fallback)
}

function stopKey(key: PickerKey) {
  key.preventDefault()
  key.stopPropagation()
}
