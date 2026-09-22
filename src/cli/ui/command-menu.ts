import type { BoxRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { type PickerRow, type PickerRowSpec, syncPickerRows } from "./picker-row.js"
import { type CommandSuggestion, type Renderer, stopKey, type UIKey } from "./types.js"

type MenuActions = {
  close: (restoreThemePreview?: boolean) => void
  select: (command: CommandSuggestion) => void
  preview?: (command: CommandSuggestion) => void
}

export class CommandMenu {
  readonly #rows: PickerRow[] = []
  #items: CommandSuggestion[] = []
  #commands: readonly CommandSuggestion[]
  #selectedIndex = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly container: BoxRenderable,
    commands: readonly CommandSuggestion[],
  ) {
    this.#commands = commands
  }

  setCommands(commands: readonly CommandSuggestion[]) {
    this.#commands = commands
  }

  showSubmenu(items: readonly CommandSuggestion[]) {
    this.#items = [...items]
    this.#selectedIndex = 0
    this.render()
  }

  update(value: string, showingWelcome: boolean, activeTheme?: string) {
    if (!value.startsWith("/") || (/\s/.test(value) && !value.startsWith("/theme "))) return false

    const visibleCommands = this.#commands.filter((command) => {
      if (!showingWelcome) return true
      return command.name !== "/home" && command.name !== "/compact" && command.name !== "/new"
    })
    const themeCommands = visibleCommands.filter((command) => command.name.startsWith("/theme "))
    const regularCommands = visibleCommands.filter((command) => !command.name.startsWith("/theme "))
    this.#items =
      value === "/theme "
        ? themeCommands
        : value === "/"
          ? regularCommands
          : regularCommands.filter((command) => command.name.startsWith(value))
    this.#selectedIndex = Math.max(0, themeItemIndex(this.#items, activeTheme))
    this.render()
    return true
  }

  refreshTheme(activeTheme?: string) {
    const themeIndex = themeItemIndex(this.#items, activeTheme)
    if (themeIndex >= 0) this.#selectedIndex = themeIndex
    this.render()
  }

  clear() {
    this.#items = []
    this.#selectedIndex = 0
  }

  selected() {
    return this.#items[this.#selectedIndex]
  }

  handleKey(key: UIKey, actions: MenuActions) {
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
      const selected = this.selected()
      if (selected) actions.preview?.(selected)
      this.renderer.requestRender()
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

  private render() {
    const specs: PickerRowSpec[] =
      this.#items.length === 0
        ? [{ title: "No matching commands", fg: colors.muted, selected: false }]
        : this.#items.map((command, index) => ({
            title: command.name.startsWith("/theme ")
              ? command.name.slice("/theme ".length)
              : command.name,
            meta: command.description || undefined,
            fg: colors.text,
            selected: index === this.#selectedIndex,
          }))
    syncPickerRows(this.renderer, this.container, this.#rows, specs, "command-row", () => ({
      bg: "background",
    }))
  }
}

function themeItemIndex(items: readonly CommandSuggestion[], activeTheme?: string) {
  if (!activeTheme) return -1
  return items.findIndex(
    (command) => command.name === activeTheme || command.name === `/theme ${activeTheme}`,
  )
}
