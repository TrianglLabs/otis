import {
  type BoxRenderable,
  type InputRenderable,
  InputRenderableEvents,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import { HiddenSecretInput } from "./hidden-secret-input.js"
import type { InputMode, Renderer, SetupCredential } from "./types.js"

type InputControllerOptions = {
  renderer: Renderer
  configured: boolean
  input: TextareaRenderable
  inputArea: BoxRenderable
  inputBox: BoxRenderable
  setupButtonBox: BoxRenderable
  setupForm: BoxRenderable
  setupInput: InputRenderable
  setupInputLabel: TextRenderable
  setupMessage: TextRenderable
  setupStatus: TextRenderable
  setupStatusBox: BoxRenderable
  welcomeQuit: TextRenderable
  isUpdateHintVisible: () => boolean
  onBeforePrimaryInput: () => void
  onSetupSubmit?: (credential: SetupCredential, apiKey: string) => void
}

export class InputController {
  mode: InputMode
  readonly #hiddenSecret: HiddenSecretInput
  #setupCredential: SetupCredential = "fireworks"

  constructor(private readonly options: InputControllerOptions) {
    this.mode = options.configured ? "chat" : "setupButton"
    this.#hiddenSecret = new HiddenSecretInput(options.setupInput, () => this.mode === "setupInput")
    options.setupInput.on(InputRenderableEvents.ENTER, () => {
      if (this.mode === "setupInput") options.onSetupSubmit?.(this.#setupCredential, this.#hiddenSecret.value)
    })
  }

  clear() {
    this.options.input.clear()
    this.clearSetupSecret()
  }

  focus() {
    if (this.mode === "chat") this.options.input.focus()
    if (this.mode === "setupInput") this.options.setupInput.focus()
  }

  setConfigured() {
    this.clearSetupSecret()
    this.mode = "chat"
    this.options.welcomeQuit.content = "/ for commands"
    this.setPrimary(this.options.inputBox)
    this.focus()
  }

  showSetupButton() {
    this.clearSetupSecret()
    this.mode = "setupButton"
    this.options.welcomeQuit.content = " "
    this.setPrimary(this.options.setupButtonBox)
  }

  showSetup(credential: SetupCredential, message = "Your key is stored only on this computer.") {
    this.clearSetupSecret()
    this.#setupCredential = credential
    this.mode = "setupInput"
    this.options.setupInputLabel.content = credential === "fireworks" ? "Fireworks key" : "Parallel key"
    this.options.setupMessage.content = message
    this.options.setupMessage.fg = colors.muted
    this.options.welcomeQuit.content = " "
    this.setPrimary(this.options.setupForm)
    this.focus()
  }

  showSetupError(message: string) {
    this.showSetup(this.#setupCredential, message)
    this.options.setupMessage.fg = colors.pink
    this.options.renderer.requestRender()
  }

  showSetupStatus(message = "Loading models...") {
    this.clearSetupSecret()
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
    this.options.inputArea.add(renderable, this.options.isUpdateHintVisible() ? 1 : 0)
    this.options.renderer.requestRender()
  }

  private clearSetupSecret() {
    this.#hiddenSecret.clear()
    this.options.setupInput.value = ""
  }
}
