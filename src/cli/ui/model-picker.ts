import { type ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import type { ModelPickerItem, Renderer } from "./types.js"

type PickerKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

export class ModelPicker {
  readonly #rows: TextRenderable[] = []
  #items: ModelPickerItem[] = []
  #selectedIndex = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly container: ScrollBoxRenderable,
  ) {}

  setItems(items: ModelPickerItem[]) {
    this.#items = items
    this.#selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.active),
    )
    this.render()
    this.scrollToSelection()
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
      if (row) this.container.remove(row.id)
    }
    rows.forEach((row, index) => {
      this.setRow(index, row.content, row.fg, row.bg)
    })
  }

  private rowData() {
    if (this.#items.length === 0) {
      return [{ content: "  No tool-capable serverless models found.", fg: colors.muted, bg: colors.surface }]
    }

    return this.#items.map((item, index) => {
      const selected = index === this.#selectedIndex
      const active = item.active ? "*" : " "
      const title = truncate(item.displayName, 40)
      const context = item.contextLength ? formatContext(item.contextLength) : "—"
      return {
        content: `${active} ${title} · ${context}`,
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
      id: `model-row-${index}`,
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
    this.container.scrollChildIntoView(`model-row-${this.#selectedIndex}`)
  }
}

function formatContext(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function stopKey(key: PickerKey) {
  key.preventDefault()
  key.stopPropagation()
}
