import type { ScrollBoxRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import {
  createPickerRow,
  type PickerRow,
  type PickerRowSpec,
  paintPickerOutline,
  pickerRowBoxId,
  stylePickerRow,
  truncatePickerLabel,
} from "./picker-row.js"
import type { Renderer, SessionPickerItem } from "./types.js"

type PickerKey = {
  name: string
  ctrl?: boolean
  meta?: boolean
  preventDefault(): void
  stopPropagation(): void
}

type PickerActions = {
  close: () => void
  create: () => void
  delete: (sessionId: string) => void
  select: (sessionId: string) => void
}

export class SessionPicker {
  readonly #rows: PickerRow[] = []
  #items: SessionPickerItem[] = []
  #selectedIndex = 0
  readonly #pulse: SelectionPulse

  constructor(
    private readonly renderer: Renderer,
    private readonly container: ScrollBoxRenderable,
  ) {
    this.#pulse = new SelectionPulse(renderer, (elapsed) => this.paintSelection(elapsed))
  }

  setItems(items: SessionPickerItem[]) {
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

  handleKey(key: PickerKey, actions: PickerActions) {
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
      actions.close()
      if (selected) actions.select(selected.id)
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "n") {
      stopKey(key)
      actions.close()
      actions.create()
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "d") {
      stopKey(key)
      const selected = this.#items[this.#selectedIndex]
      if (selected) {
        this.#items.splice(this.#selectedIndex, 1)
        this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#items.length - 1))
        this.render()
        this.renderer.requestRender()
        actions.delete(selected.id)
      }
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
      return [{ title: "No sessions yet", meta: "Press n to start one", fg: colors.muted, selected: false }]
    }

    return this.#items.map((item, index) => ({
      title: truncatePickerLabel(item.title, 30),
      meta: item.detail ? truncatePickerLabel(item.detail, 30) : undefined,
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

    const row = createPickerRow(this.renderer, `session-row-${index}`, { outline: true })
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
    this.container.scrollChildIntoView(pickerRowBoxId(`session-row-${this.#selectedIndex}`))
  }
}

function stopKey(key: PickerKey) {
  key.preventDefault()
  key.stopPropagation()
}
