import type { ScrollBoxRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { SelectionPulse } from "./color-pulse.js"
import {
  type PickerRow,
  type PickerRowSpec,
  paintPickerOutline,
  pickerRowBoxId,
  syncPickerRows,
  truncatePickerLabel,
} from "./picker-row.js"
import { type Renderer, type SessionPickerItem, stopKey, type UIKey } from "./types.js"

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
    this.#pulse = new SelectionPulse(renderer, (elapsed) => {
      if (this.#items.length > 0) paintPickerOutline(this.#rows[this.#selectedIndex], true, elapsed)
    })
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

  handleKey(key: UIKey, actions: PickerActions) {
    if (key.name === "escape") {
      stopKey(key)
      actions.close()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      stopKey(key)
      if (this.#items.length === 0) return true
      const delta = key.name === "up" ? -1 : 1
      this.#selectedIndex = (this.#selectedIndex + delta + this.#items.length) % this.#items.length
      this.render()
      this.scrollToSelection()
      this.renderer.requestRender()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      stopKey(key)
      const selected = this.#items[this.#selectedIndex]
      actions.close()
      if (selected) actions.select(selected.id)
      return true
    }
    if (key.ctrl || key.meta) return false
    if (key.name === "n") {
      stopKey(key)
      actions.close()
      actions.create()
      return true
    }
    if (key.name === "d") {
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

  private render() {
    const specs: PickerRowSpec[] =
      this.#items.length === 0
        ? [
            {
              title: "No sessions yet",
              meta: "Press n to start one",
              fg: colors.muted,
              selected: false,
            },
          ]
        : this.#items.map((item, index) => ({
            title: truncatePickerLabel(item.title, 30),
            meta: item.detail ? truncatePickerLabel(item.detail, 30) : undefined,
            fg: item.active ? colors.accent : colors.text,
            selected: index === this.#selectedIndex,
          }))
    syncPickerRows(
      this.renderer,
      this.container,
      this.#rows,
      specs,
      "session-row",
      () => ({ outline: true }),
      this.#pulse.elapsed(),
    )
  }

  private scrollToSelection() {
    this.container.scrollChildIntoView(pickerRowBoxId(`session-row-${this.#selectedIndex}`))
  }
}
