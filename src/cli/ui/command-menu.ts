import { type BoxRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import type { CommandSuggestion, Renderer } from "./types.js"

type MenuKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

type MenuActions = {
  close: (restoreThemePreview?: boolean) => void
  select: (command: CommandSuggestion) => void
  preview?: (command: CommandSuggestion) => void
}

export class CommandMenu {
  readonly #rows: TextRenderable[] = []
  #items: CommandSuggestion[] = []
  #selectedIndex = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly container: BoxRenderable,
    private readonly commands: readonly CommandSuggestion[],
  ) {}

  update(value: string, showingWelcome: boolean, activeTheme?: string) {
    const query = commandQuery(value)
    if (query === undefined) return false

    const visibleCommands = this.commands.filter((command) => {
      if (!showingWelcome) return true
      return command.name !== "/home" && command.name !== "/compact" && command.name !== "/new"
    })
    const themeCommands = visibleCommands.filter((command) => command.name.startsWith("/theme "))
    const regularCommands = visibleCommands.filter((command) => !command.name.startsWith("/theme "))
    this.#items =
      query === "/theme "
        ? themeCommands
        : query === "/"
          ? regularCommands
          : regularCommands.filter((command) => command.name.startsWith(query))
    this.#selectedIndex = Math.max(
      0,
      this.#items.findIndex((command) => command.name === `/theme ${activeTheme}`),
    )
    this.render()
    return true
  }

  clear() {
    this.#items = []
    this.#selectedIndex = 0
  }

  selected() {
    return this.#items[this.#selectedIndex]
  }

  handleKey(key: MenuKey, actions: MenuActions) {
    if (key.name === "escape") {
      stopKey(key)
      actions.close()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      stopKey(key)
      this.move(key.name === "up" ? -1 : 1, actions.preview)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      stopKey(key)
      const selected = this.selected()
      actions.close(false)
      if (selected) actions.select(selected)
      return true
    }
    return false
  }

  private move(delta: number, preview?: (command: CommandSuggestion) => void) {
    if (this.#items.length === 0) return
    this.#selectedIndex = (this.#selectedIndex + delta + this.#items.length) % this.#items.length
    this.render()
    const selected = this.selected()
    if (selected) preview?.(selected)
    this.renderer.requestRender()
  }

  private render() {
    const rows =
      this.#items.length > 0
        ? this.#items.map((command, index) => {
            const selected = index === this.#selectedIndex
            // Theme choices render as just the theme name (e.g. "default");
            // the `/theme ` prefix is submitted but not displayed, and the
            // entries carry no description by design.
            const content = command.name.startsWith("/theme ")
              ? command.name.slice("/theme ".length)
              : `${command.name.padEnd(10)} ${command.description}`
            return {
              content,
              fg: selected ? colors.background : colors.text,
              bg: selected ? colors.accent : colors.surface,
            }
          })
        : [{ content: "  No matching commands", fg: colors.muted, bg: colors.surface }]

    while (this.#rows.length > rows.length) {
      const row = this.#rows.pop()
      if (row) this.container.remove(row.id)
    }

    rows.forEach((row, index) => {
      this.setRow(index, row.content, row.fg, row.bg)
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
      id: `command-row-${index}`,
      content,
      width: "100%",
      fg,
      bg,
      truncate: true,
      selectable: false,
    })
    this.#rows.push(row)
    this.container.add(row)
  }
}

function commandQuery(value: string) {
  if (!value.startsWith("/") || (/\s/.test(value) && !value.startsWith("/theme "))) return undefined
  return value
}

function stopKey(key: MenuKey) {
  key.preventDefault()
  key.stopPropagation()
}
