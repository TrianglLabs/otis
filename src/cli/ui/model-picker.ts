import type { ScrollBoxRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import { FAST_MODEL_LABEL } from "./format.js"
import {
  createPickerRow,
  type PickerRow,
  type PickerRowSpec,
  paintPickerOutline,
  pickerRowBoxId,
  stylePickerRow,
  truncatePickerLabel,
} from "./picker-row.js"
import type { ModelPickerItem, Renderer } from "./types.js"

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
    this.#pulse = new SelectionPulse(renderer, (elapsed) => this.paintSelection(elapsed))
  }

  setItems(items: ModelPickerItem[]) {
    this.#items = items
    this.#selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.active),
    )
    this.render()
    this.scrollToSelection()
    this.#pulse.start()
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
      if (selected) actions.select(selected)
      return true
    }
    return false
  }

  private move(delta: number) {
    if (this.#items.length === 0) return
    this.#selectedIndex = (this.#selectedIndex + delta + this.#items.length) % this.#items.length
    this.render()
    this.scrollToSelection()
    this.renderer.requestRender()
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

    return this.#items.map((item, index) => ({
      title: modelPickerTitle(item),
      meta: modelMeta(item),
      fg: item.active ? colors.accent : colors.text,
      selected: index === this.#selectedIndex,
    }))
  }

  private setRow(index: number, spec: PickerRowSpec) {
    const existing = this.#rows[index]
    if (existing) {
      stylePickerRow(existing, spec, this.#pulse.elapsed())
      return
    }
    const row = createPickerRow(this.renderer, `model-row-${index}`, { outline: true })
    stylePickerRow(row, spec, this.#pulse.elapsed())
    this.#rows.push(row)
    this.container.add(row.box)
  }

  private paintSelection(elapsedMs: number) {
    if (this.#items.length === 0) return
    const row = this.#rows[this.#selectedIndex]
    if (row) paintPickerOutline(row, true, elapsedMs)
  }

  private scrollToSelection() {
    this.container.scrollChildIntoView(pickerRowBoxId(`model-row-${this.#selectedIndex}`))
  }
}

function modelPickerTitle(item: ModelPickerItem) {
  return truncatePickerLabel(item.displayName, 30)
}

function modelMeta(item: ModelPickerItem) {
  const parts: string[] = []
  if (item.contextLength) parts.push(formatContext(item.contextLength))
  parts.push(item.supportsImageInput ? "Vision" : "Text")
  if (item.fastId) parts.push(FAST_MODEL_LABEL)
  return parts.join(" · ")
}

function formatContext(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function stopKey(key: PickerKey) {
  key.preventDefault()
  key.stopPropagation()
}
