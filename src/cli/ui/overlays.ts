import type { BoxRenderable } from "@opentui/core"
import { isThemeName, type ThemeName } from "../../local/settings.js"
import type { CommandMenu } from "./command-menu.js"
import type { ModelPicker } from "./model-picker.js"
import type { SessionPicker } from "./session-picker.js"
import type { CommandSuggestion, ModelPickerItem, Renderer, SessionPickerItem } from "./types.js"

type OverlayKey = {
  name: string
  ctrl?: boolean
  meta?: boolean
  preventDefault(): void
  stopPropagation(): void
}

type OverlayHostOptions = {
  renderer: Renderer
  chatBody: BoxRenderable
  inputArea: BoxRenderable
  commandMenu: BoxRenderable
  modelPanel: BoxRenderable
  sessionPanel: BoxRenderable
  commands: CommandMenu
  models: ModelPicker
  sessions: SessionPicker
  showingWelcome: () => boolean
  activeTheme: () => ThemeName
  onSubmit: (value: string) => void
  onPreviewTheme?: (theme: ThemeName) => void
  onCancelThemePreview?: () => void
  onCloseModelPicker?: () => void
  onSelectModel?: (model: ModelPickerItem) => void
  onNewSession?: () => void
  onDeleteSession?: (sessionId: string) => void
  onSelectSession?: (sessionId: string) => void
  showChatLayout: () => void
  hideSetupStatus: () => void
  clearInput: () => void
  focusInput: () => void
  suspendStatus: () => void
  restoreStatus: () => void
}

export class OverlayHost {
  #commandMenuVisible = false
  #modelPickerVisible = false
  #sessionPickerVisible = false
  #themeMenuOpen = false

  constructor(private readonly options: OverlayHostOptions) {}

  get commandMenuVisible() {
    return this.#commandMenuVisible
  }

  get themeMenuOpen() {
    return this.#themeMenuOpen
  }

  handleKey(key: OverlayKey) {
    if (this.#commandMenuVisible && this.#handleCommandMenuKey(key)) return true
    if (this.#modelPickerVisible && this.#handleModelPickerKey(key)) return true
    if (this.#sessionPickerVisible && this.#handleSessionPickerKey(key)) return true
    return false
  }

  submitFromInput(value: string) {
    if (!this.#commandMenuVisible) return false
    const selected = this.options.commands.selected()
    this.hideCommandMenu(false)
    this.#selectCommand(selected, value.trim())
    return true
  }

  updateCommandMenu(value: string) {
    this.#themeMenuOpen = false
    if (!this.options.commands.update(value, this.options.showingWelcome(), this.options.activeTheme())) {
      this.hideCommandMenu()
      return
    }
    this.#showCommandMenu()
  }

  showThemeMenu() {
    this.options.commands.update("/theme ", this.options.showingWelcome(), this.options.activeTheme())
    this.#themeMenuOpen = true
    this.#showCommandMenu()
  }

  showCommandSubmenu(items: readonly CommandSuggestion[]) {
    this.#themeMenuOpen = false
    this.options.commands.showSubmenu(items)
    this.#showCommandMenu()
  }

  hideCommandMenu(restoreThemePreview = true) {
    if (!this.#commandMenuVisible) return
    this.options.inputArea.remove(this.options.commandMenu.id)
    this.#commandMenuVisible = false
    this.#themeMenuOpen = false
    this.options.commands.clear()
    if (restoreThemePreview) this.options.onCancelThemePreview?.()
    this.options.restoreStatus()
    this.options.renderer.requestRender()
  }

  showSessionPicker(items: SessionPickerItem[]) {
    this.options.showChatLayout()
    this.#dismissModelPicker()
    this.options.models.stop()
    this.options.sessions.setItems(items)
    if (!this.#sessionPickerVisible) {
      this.options.chatBody.add(this.options.sessionPanel, 0)
      this.#sessionPickerVisible = true
    }
    this.options.renderer.requestRender()
  }

  showModelPicker(items: ModelPickerItem[]) {
    this.options.hideSetupStatus()
    this.options.showChatLayout()
    this.#dismissSessionPicker()
    this.options.models.setItems(items)
    if (!this.#modelPickerVisible) {
      this.options.chatBody.add(this.options.modelPanel, 0)
      this.#modelPickerVisible = true
    }
    this.options.renderer.requestRender()
  }

  hideModelPicker() {
    if (!this.#modelPickerVisible) return
    this.#dismissModelPicker()
    this.options.focusInput()
    this.options.renderer.requestRender()
  }

  hideSessionPicker() {
    if (!this.#sessionPickerVisible) return
    this.#dismissSessionPicker()
    this.options.focusInput()
    this.options.renderer.requestRender()
  }

  dismissPickers() {
    this.#dismissSessionPicker()
    this.#dismissModelPicker()
  }

  refreshTheme() {
    if (this.#commandMenuVisible) this.options.commands.refreshTheme(this.options.activeTheme())
  }

  #showCommandMenu() {
    if (!this.#commandMenuVisible) {
      this.options.suspendStatus()
      this.options.inputArea.add(this.options.commandMenu)
      this.#commandMenuVisible = true
    }
    this.options.renderer.requestRender()
  }

  #selectCommand(command: CommandSuggestion | undefined, fallback: string) {
    if (command?.name === "/theme") {
      this.#openThemeMenu()
      return
    }
    this.options.onSubmit(command?.submission ?? command?.name ?? fallback)
  }

  #openThemeMenu() {
    this.options.clearInput()
    this.showThemeMenu()
    this.options.focusInput()
  }

  #dismissModelPicker() {
    if (!this.#modelPickerVisible) return
    this.options.models.stop()
    this.options.chatBody.remove(this.options.modelPanel.id)
    this.#modelPickerVisible = false
  }

  #dismissSessionPicker() {
    if (!this.#sessionPickerVisible) return
    this.options.sessions.stop()
    this.options.chatBody.remove(this.options.sessionPanel.id)
    this.#sessionPickerVisible = false
  }

  #handleCommandMenuKey(key: OverlayKey) {
    const handled = this.options.commands.handleKey(key, {
      close: (restoreThemePreview) => this.hideCommandMenu(restoreThemePreview),
      select: (command: CommandSuggestion) => this.#selectCommand(command, command.name),
      preview: (command) => {
        const theme = themeFromCommand(command.name)
        if (theme) this.options.onPreviewTheme?.(theme)
      },
    })
    if (handled && key.name === "escape") this.options.focusInput()
    return handled
  }

  #handleSessionPickerKey(key: OverlayKey) {
    return this.options.sessions.handleKey(key, {
      close: () => this.hideSessionPicker(),
      create: () => this.options.onNewSession?.(),
      delete: (sessionId) => this.options.onDeleteSession?.(sessionId),
      select: (sessionId) => this.options.onSelectSession?.(sessionId),
    })
  }

  #handleModelPickerKey(key: OverlayKey) {
    return this.options.models.handleKey(key, {
      close: () => {
        this.hideModelPicker()
        this.options.onCloseModelPicker?.()
      },
      select: (model) => this.options.onSelectModel?.(model),
    })
  }
}

function themeFromCommand(command: string): ThemeName | undefined {
  const theme = command.slice("/theme ".length)
  return isThemeName(theme) ? theme : undefined
}
