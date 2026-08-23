import {
  type BoxRenderable,
  type InputRenderable,
  InputRenderableEvents,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import { bindAccentButton } from "./input-views.js"
import type { InputMode, Renderer } from "./types.js"

type InputControllerOptions = {
  renderer: Renderer
  configured: boolean
  input: TextareaRenderable
  inputArea: BoxRenderable
  inputBox: BoxRenderable
  setupButtonBox: BoxRenderable
  setupContinueButton: BoxRenderable
  setupForm: BoxRenderable
  setupInput: InputRenderable
  setupInputLabel: TextRenderable
  setupMessage: TextRenderable
  setupStartButton: BoxRenderable
  setupStatus: TextRenderable
  setupStatusBox: BoxRenderable
  welcomeQuit: TextRenderable
  onBeforePrimaryInput: () => void
  onSetup?: () => void
  onSetupSubmit?: (apiKey: string) => void
}

type SetupKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

export class InputController {
  mode: InputMode

  constructor(private readonly options: InputControllerOptions) {
    this.mode = options.configured ? "chat" : "setupButton"
    options.setupInput.on(InputRenderableEvents.ENTER, () => this.#submitSetup())
    bindAccentButton(options.setupStartButton, options.renderer, () => options.onSetup?.())
    bindAccentButton(options.setupContinueButton, options.renderer, () => this.#submitSetup())
  }

  handleKey(key: SetupKey) {
    if (this.mode !== "setupButton") return false
    if (key.name !== "return" && key.name !== "enter") return false
    key.preventDefault()
    key.stopPropagation()
    this.options.onSetup?.()
    return true
  }

  clear() {
    this.options.input.clear()
    this.clearSetupInput()
  }

  focus() {
    if (this.mode === "chat") this.options.input.focus()
    if (this.mode === "setupInput") this.options.setupInput.focus()
  }

  setConfigured() {
    this.clearSetupInput()
    this.mode = "chat"
    this.options.welcomeQuit.content = "/ for commands"
    this.setPrimary(this.options.inputBox)
    this.focus()
  }

  showSetupButton() {
    this.clearSetupInput()
    this.mode = "setupButton"
    this.options.welcomeQuit.content = " "
    this.setPrimary(this.options.setupButtonBox)
  }

  showSetup(message = "") {
    this.clearSetupInput()
    this.mode = "setupInput"
    this.options.setupInputLabel.content = "Fireworks API key"
    this.options.welcomeQuit.content = " "
    this.#setSetupMessage(message, false)
    this.setPrimary(this.options.setupForm)
    this.focus()
  }

  showSetupError(message: string) {
    this.showSetup(message)
    this.#setSetupMessage(message, true)
  }

  showSetupStatus(message = "Loading models...") {
    this.clearSetupInput()
    this.mode = "setupStatus"
    this.options.setupStatus.content = message
    this.options.welcomeQuit.content = " "
    this.setPrimary(this.options.setupStatusBox)
  }

  hideSetupStatus() {
    if (this.mode !== "setupStatus") return
    this.mode = "inactive"
    this.options.inputArea.remove(this.options.setupStatusBox.id)
    this.options.renderer.requestRender()
  }

  private setPrimary(renderable: BoxRenderable) {
    this.options.onBeforePrimaryInput()
    this.options.inputArea.remove(this.options.inputBox.id)
    this.options.inputArea.remove(this.options.setupButtonBox.id)
    this.options.inputArea.remove(this.options.setupForm.id)
    this.options.inputArea.remove(this.options.setupStatusBox.id)
    this.options.inputArea.add(renderable, 0)
    this.options.renderer.requestRender()
  }

  private clearSetupInput() {
    this.options.setupInput.value = ""
  }

  #submitSetup() {
    if (this.mode !== "setupInput") return
    this.options.onSetupSubmit?.(this.options.setupInput.value)
  }

  #setSetupMessage(message: string, error: boolean) {
    const { setupForm, setupMessage } = this.options
    setupMessage.content = message
    setupMessage.fg = error ? colors.pink : colors.muted
    const mounted = setupForm.getChildren().some((child) => child.id === setupMessage.id)
    if (message) {
      if (!mounted) setupForm.add(setupMessage, 1)
    } else if (mounted) {
      setupForm.remove(setupMessage.id)
    }
    this.options.renderer.requestRender()
  }
}
