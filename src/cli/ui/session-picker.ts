import { type ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
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
  readonly #rows: TextRenderable[] = []
  #items: SessionPickerItem[] = []
  #selectedIndex = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly container: ScrollBoxRenderable,
  ) {}

  setItems(items: SessionPickerItem[]) {
    this.#items = items
    this.#selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.active),
    )
    this.render()
    this.scrollToSelection()
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
      if (row) this.container.remove(row.id)
    }
    rows.forEach((row, index) => {
      this.setRow(index, row.content, row.fg, row.bg)
    })
  }

  private rowData() {
    if (this.#items.length === 0) {
      return [{ content: "  No sessions yet. Press n to start one.", fg: colors.muted, bg: colors.surface }]
    }

    return this.#items.map((item, index) => {
      const selected = index === this.#selectedIndex
      const active = item.active ? "*" : " "
      const title = truncateText(item.title, 34)
      const detail = item.detail ? truncateText(item.detail, 34) : ""
      const separator = index < this.#items.length - 1 ? `\n${"─".repeat(38)}` : ""
      return {
        content: `${`${active} ${title}`.padEnd(38)}\n${`    ${detail}`.padEnd(38)}${separator}`,
        fg: selected ? colors.background : item.active ? colors.accent : colors.text,
        bg: selected ? colors.accent : colors.surface,
      }
    })
  }

  private setRow(index: number, content: string, fg: string, bg: string) {
    const existing = this.#rows[index]
    if (existing) {
      existing.content = content
      existing.fg = fg
      existing.bg = bg
      return
    }

    const row = new TextRenderable(this.renderer, {
      id: `session-row-${index}`,
      content,
      width: "100%",
      fg,
      bg,
      selectable: false,
    })
    this.#rows.push(row)
    this.container.add(row)
  }

  private scrollToSelection() {
    this.container.scrollChildIntoView(`session-row-${this.#selectedIndex}`)
  }
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function stopKey(key: PickerKey) {
  key.preventDefault()
  key.stopPropagation()
}
