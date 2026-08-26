import {
  type BoxRenderable,
  type InputRenderable,
  InputRenderableEvents,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import { colorPulseAmount, SelectionPulse, selectionOutline } from "./color-pulse.js"
import { bindAccentButton } from "./input-views.js"
import type { InputMode, Renderer, SetupInferenceChoice, SetupInputCancelTarget } from "./types.js"

type InputControllerOptions = {
  renderer: Renderer
  configured: boolean
  localInferenceUnavailableReason?: string
  input: TextareaRenderable
  inputArea: BoxRenderable
  inputBox: BoxRenderable
  setupButtonBox: BoxRenderable
  setupChoiceBox: BoxRenderable
  setupChoiceMessage: TextRenderable
  setupHostedCard: BoxRenderable
  setupLocalCard: BoxRenderable
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
  onModeChange?: (mode: InputMode) => void
  onSetup?: () => void
  onSetupInferenceChoice?: (choice: SetupInferenceChoice) => void
  onSetupSubmit?: (apiKey: string) => void
}

type SetupKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

export class InputController {
  mode: InputMode
  #setupInferenceChoice: SetupInferenceChoice = "local"
  #setupInputCancelTarget: SetupInputCancelTarget = "choice"
  readonly #setupChoicePulse: SelectionPulse

  constructor(private readonly options: InputControllerOptions) {
    this.mode = options.configured ? "chat" : "setupButton"
    if (options.localInferenceUnavailableReason) this.#setupInferenceChoice = "hosted"
    this.#setupChoicePulse = new SelectionPulse(options.renderer, (elapsed) => this.#paintInferenceChoice(elapsed))
    options.setupInput.on(InputRenderableEvents.ENTER, () => this.#submitSetup())
    bindAccentButton(options.setupStartButton, options.renderer, () => options.onSetup?.())
    bindAccentButton(options.setupContinueButton, options.renderer, () => this.#submitSetup())
    bindAccentButton(options.setupLocalCard, options.renderer, () => this.#selectInferenceChoice("local"))
    bindAccentButton(options.setupHostedCard, options.renderer, () => this.#selectInferenceChoice("hosted"))
  }

  handleKey(key: SetupKey) {
    if (this.mode === "setupInput" && key.name === "escape") {
      stopKey(key)
      if (this.#setupInputCancelTarget === "configured") this.setConfigured()
      else this.showSetupInferenceChoice()
      return true
    }
    if (this.mode === "setupButton") {
      if (key.name !== "return" && key.name !== "enter") return false
      stopKey(key)
      this.options.onSetup?.()
      return true
    }
    if (this.mode !== "setupChoice") return false
    if (["left", "right", "up", "down"].includes(key.name)) {
      stopKey(key)
      this.#setupInferenceChoice =
        !this.options.localInferenceUnavailableReason && (key.name === "left" || key.name === "up") ? "local" : "hosted"
      this.#paintInferenceChoice()
      this.options.renderer.requestRender()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      stopKey(key)
      this.options.onSetupInferenceChoice?.(this.#setupInferenceChoice)
      return true
    }
    if (key.name === "escape") {
      stopKey(key)
      this.#showSetupButton()
      return true
    }
    return false
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

  #showSetupButton() {
    this.clearSetupInput()
    this.mode = "setupButton"
    this.options.welcomeQuit.content = " "
    this.setPrimary(this.options.setupButtonBox)
  }

  showSetupInferenceChoice(message = "") {
    this.clearSetupInput()
    this.mode = "setupChoice"
    this.options.welcomeQuit.content = " "
    this.#setSetupChoiceMessage(message || this.options.localInferenceUnavailableReason || "")
    this.setPrimary(this.options.setupChoiceBox)
    this.#setupChoicePulse.start()
  }

  showSetup(message = "", cancelTarget: SetupInputCancelTarget = "choice") {
    this.clearSetupInput()
    this.#setupInputCancelTarget = cancelTarget
    this.mode = "setupInput"
    this.options.setupInputLabel.content = "Fireworks API key"
    this.options.welcomeQuit.content = " "
    this.#setSetupMessage(message, false)
    this.setPrimary(this.options.setupForm)
    this.focus()
  }

  showSetupError(message: string, cancelTarget: SetupInputCancelTarget) {
    this.showSetup(message, cancelTarget)
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
    this.options.onModeChange?.(this.mode)
    if (renderable !== this.options.setupChoiceBox) this.#setupChoicePulse.stop()
    this.options.input.blur()
    this.options.setupInput.blur()
    this.options.inputArea.remove(this.options.inputBox.id)
    this.options.inputArea.remove(this.options.setupButtonBox.id)
    this.options.inputArea.remove(this.options.setupChoiceBox.id)
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

  #selectInferenceChoice(choice: SetupInferenceChoice) {
    if (this.mode !== "setupChoice") return
    if (choice === "local" && this.options.localInferenceUnavailableReason) {
      this.#setupInferenceChoice = "hosted"
      this.#setSetupChoiceMessage(this.options.localInferenceUnavailableReason)
      this.#paintInferenceChoice()
      return
    }
    this.#setupInferenceChoice = choice
    this.#paintInferenceChoice()
    this.options.renderer.requestRender()
    this.options.onSetupInferenceChoice?.(choice)
  }

  #paintInferenceChoice(elapsedMs = this.#setupChoicePulse.elapsed()) {
    this.#paintInferenceCard(this.options.setupLocalCard, "local", elapsedMs)
    this.#paintInferenceCard(this.options.setupHostedCard, "hosted", elapsedMs)
  }

  #paintInferenceCard(card: BoxRenderable, value: SetupInferenceChoice, elapsedMs: number) {
    const selected = this.#setupInferenceChoice === value
    card.borderColor = selected ? selectionOutline(colorPulseAmount(elapsedMs)) : colors.border
  }

  #setSetupChoiceMessage(message: string) {
    const { setupChoiceBox, setupChoiceMessage } = this.options
    setupChoiceMessage.content = message
    const mounted = setupChoiceBox.getChildren().some((child) => child.id === setupChoiceMessage.id)
    if (message) {
      if (!mounted) setupChoiceBox.add(setupChoiceMessage, 3)
    } else if (mounted) {
      setupChoiceBox.remove(setupChoiceMessage.id)
    }
    this.options.renderer.requestRender()
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

function stopKey(key: SetupKey) {
  key.preventDefault()
  key.stopPropagation()
}
