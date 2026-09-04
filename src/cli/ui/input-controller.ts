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
import type {
  InputMode,
  PairEndpointInputs,
  Renderer,
  SetupInferenceChoice,
  SetupInputCancelTarget,
  SetupLocalInferenceChoice,
} from "./types.js"

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
  setupLocalChoiceBox: BoxRenderable
  setupLocalChoiceMessage: TextRenderable
  setupLocalCard: BoxRenderable
  setupManagedLocalCard: BoxRenderable
  setupPairCard: BoxRenderable
  setupPairForm: BoxRenderable
  setupPairLMStudioInput: InputRenderable
  setupPairMessage: TextRenderable
  setupPairOllamaInput: InputRenderable
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
  onSetupLocalInferenceChoice?: (choice: SetupLocalInferenceChoice) => void
  onSetupSubmit?: (value: string) => void
  onPairSetupSubmit?: (endpoints: PairEndpointInputs) => void
}

type SetupKey = {
  name: string
  sequence?: string
  preventDefault(): void
  stopPropagation(): void
}

export class InputController {
  mode: InputMode
  #setupInferenceChoice: SetupInferenceChoice = "local"
  #setupLocalInferenceChoice: SetupLocalInferenceChoice = "managed"
  #setupInputCancelTarget: SetupInputCancelTarget = "choice"
  readonly #setupChoicePulse: SelectionPulse

  constructor(private readonly options: InputControllerOptions) {
    this.mode = options.configured ? "chat" : "setupButton"
    if (options.localInferenceUnavailableReason) this.#setupLocalInferenceChoice = "pair"
    this.#setupChoicePulse = new SelectionPulse(options.renderer, (elapsed) => {
      if (this.mode === "setupLocalChoice") this.#paintLocalInferenceChoice(elapsed)
      else this.#paintInferenceChoice(elapsed)
    })
    options.setupInput.on(InputRenderableEvents.ENTER, () => this.#submitSetup())
    options.setupPairOllamaInput.on(InputRenderableEvents.ENTER, () => this.#submitPairSetup())
    options.setupPairLMStudioInput.on(InputRenderableEvents.ENTER, () => this.#submitPairSetup())
    bindAccentButton(options.setupStartButton, options.renderer, () => options.onSetup?.())
    bindAccentButton(options.setupContinueButton, options.renderer, () => this.#submitSetup())
    bindAccentButton(options.setupLocalCard, options.renderer, () => this.#selectInferenceChoice("local"))
    bindAccentButton(options.setupHostedCard, options.renderer, () => this.#selectInferenceChoice("hosted"))
    bindAccentButton(options.setupManagedLocalCard, options.renderer, () => this.#selectLocalInferenceChoice("managed"))
    bindAccentButton(options.setupPairCard, options.renderer, () => this.#selectLocalInferenceChoice("pair"))
  }

  handleKey(key: SetupKey) {
    if (this.mode === "setupInput" && key.name === "escape") {
      stopKey(key)
      if (this.#setupInputCancelTarget === "configured") this.setConfigured()
      else if (this.#setupInputCancelTarget === "local") this.showSetupLocalInferenceChoice()
      else this.showSetupInferenceChoice()
      return true
    }
    if (this.mode === "setupPairInput" && key.name === "escape") {
      stopKey(key)
      if (this.#setupInputCancelTarget === "configured") this.setConfigured()
      else this.showSetupLocalInferenceChoice()
      return true
    }
    if (this.mode === "setupPairInput" && (key.name === "tab" || key.sequence === "\t")) {
      stopKey(key)
      if (this.options.setupPairOllamaInput.focused) this.#focusPairInput("lmStudio")
      else this.#focusPairInput("ollama")
      return true
    }
    if (this.mode === "setupButton") {
      if (key.name !== "return" && key.name !== "enter") return false
      stopKey(key)
      this.options.onSetup?.()
      return true
    }
    if (this.mode === "setupChoice" && ["left", "right", "up", "down"].includes(key.name)) {
      stopKey(key)
      this.#setupInferenceChoice = key.name === "left" || key.name === "up" ? "local" : "hosted"
      this.#paintInferenceChoice()
      this.options.renderer.requestRender()
      return true
    }
    if (this.mode === "setupChoice" && (key.name === "return" || key.name === "enter")) {
      stopKey(key)
      this.options.onSetupInferenceChoice?.(this.#setupInferenceChoice)
      return true
    }
    if (this.mode === "setupChoice" && key.name === "escape") {
      stopKey(key)
      this.#showSetupButton()
      return true
    }
    if (this.mode === "setupLocalChoice" && ["left", "right", "up", "down"].includes(key.name)) {
      stopKey(key)
      const managed = key.name === "left" || key.name === "up"
      this.#setupLocalInferenceChoice = managed && !this.options.localInferenceUnavailableReason ? "managed" : "pair"
      this.#paintLocalInferenceChoice()
      this.options.renderer.requestRender()
      return true
    }
    if (this.mode === "setupLocalChoice" && (key.name === "return" || key.name === "enter")) {
      stopKey(key)
      this.options.onSetupLocalInferenceChoice?.(this.#setupLocalInferenceChoice)
      return true
    }
    if (this.mode === "setupLocalChoice" && key.name === "escape") {
      stopKey(key)
      this.showSetupInferenceChoice()
      return true
    }
    if (this.mode !== "setupChoice" && this.mode !== "setupLocalChoice") return false
    return false
  }

  clear() {
    this.options.input.clear()
    this.clearSetupInput()
  }

  focus() {
    if (this.mode === "chat") this.options.input.focus()
    if (this.mode === "setupInput") this.options.setupInput.focus()
    if (this.mode === "setupPairInput") this.#focusPairInput("ollama")
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
    this.#setSetupChoiceMessage(message)
    this.setPrimary(this.options.setupChoiceBox)
    this.#setupChoicePulse.start()
  }

  showSetupLocalInferenceChoice(message = "") {
    this.clearSetupInput()
    this.mode = "setupLocalChoice"
    this.options.welcomeQuit.content = " "
    this.#setLocalSetupChoiceMessage(message || this.options.localInferenceUnavailableReason || "")
    this.setPrimary(this.options.setupLocalChoiceBox)
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

  showPairSetup(message: string, cancelTarget: SetupInputCancelTarget, endpoints: PairEndpointInputs) {
    this.clearSetupInput()
    this.#setupInputCancelTarget = cancelTarget
    this.mode = "setupPairInput"
    this.options.setupPairOllamaInput.value = endpoints.ollama
    this.options.setupPairLMStudioInput.value = endpoints.lmStudio
    this.options.welcomeQuit.content = " "
    this.#setPairSetupMessage(message, false)
    this.setPrimary(this.options.setupPairForm)
    this.focus()
  }

  showPairSetupError(message: string, cancelTarget: SetupInputCancelTarget, endpoints: PairEndpointInputs) {
    this.showPairSetup(message, cancelTarget, endpoints)
    this.#setPairSetupMessage(message, true)
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
    this.options.setupPairOllamaInput.blur()
    this.options.setupPairLMStudioInput.blur()
    this.options.inputArea.remove(this.options.inputBox.id)
    this.options.inputArea.remove(this.options.setupButtonBox.id)
    this.options.inputArea.remove(this.options.setupChoiceBox.id)
    this.options.inputArea.remove(this.options.setupLocalChoiceBox.id)
    this.options.inputArea.remove(this.options.setupForm.id)
    this.options.inputArea.remove(this.options.setupPairForm.id)
    this.options.inputArea.remove(this.options.setupStatusBox.id)
    this.options.inputArea.add(renderable, 0)
    this.options.renderer.requestRender()
  }

  private clearSetupInput() {
    this.options.setupInput.value = ""
    this.options.setupPairOllamaInput.value = ""
    this.options.setupPairLMStudioInput.value = ""
  }

  #submitSetup() {
    if (this.mode !== "setupInput") return
    this.options.onSetupSubmit?.(this.options.setupInput.value)
  }

  #submitPairSetup() {
    if (this.mode !== "setupPairInput") return
    this.options.onPairSetupSubmit?.({
      ollama: this.options.setupPairOllamaInput.value,
      lmStudio: this.options.setupPairLMStudioInput.value,
    })
  }

  #focusPairInput(input: keyof PairEndpointInputs) {
    this.options.setupPairOllamaInput.blur()
    this.options.setupPairLMStudioInput.blur()
    if (input === "ollama") this.options.setupPairOllamaInput.focus()
    else this.options.setupPairLMStudioInput.focus()
    this.options.renderer.requestRender()
  }

  #selectInferenceChoice(choice: SetupInferenceChoice) {
    if (this.mode !== "setupChoice") return
    this.#setupInferenceChoice = choice
    this.#paintInferenceChoice()
    this.options.renderer.requestRender()
    this.options.onSetupInferenceChoice?.(choice)
  }

  #selectLocalInferenceChoice(choice: SetupLocalInferenceChoice) {
    if (this.mode !== "setupLocalChoice") return
    if (choice === "managed" && this.options.localInferenceUnavailableReason) {
      this.#setupLocalInferenceChoice = "pair"
      this.#setLocalSetupChoiceMessage(this.options.localInferenceUnavailableReason)
      this.#paintLocalInferenceChoice()
      return
    }
    this.#setupLocalInferenceChoice = choice
    this.#paintLocalInferenceChoice()
    this.options.renderer.requestRender()
    this.options.onSetupLocalInferenceChoice?.(choice)
  }

  #paintInferenceChoice(elapsedMs = this.#setupChoicePulse.elapsed()) {
    this.#paintInferenceCard(this.options.setupLocalCard, "local", elapsedMs)
    this.#paintInferenceCard(this.options.setupHostedCard, "hosted", elapsedMs)
  }

  #paintLocalInferenceChoice(elapsedMs = this.#setupChoicePulse.elapsed()) {
    this.#paintLocalInferenceCard(this.options.setupManagedLocalCard, "managed", elapsedMs)
    this.#paintLocalInferenceCard(this.options.setupPairCard, "pair", elapsedMs)
  }

  #paintLocalInferenceCard(card: BoxRenderable, value: SetupLocalInferenceChoice, elapsedMs: number) {
    const selected = this.#setupLocalInferenceChoice === value
    card.borderColor = selected ? selectionOutline(colorPulseAmount(elapsedMs)) : colors.border
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

  #setLocalSetupChoiceMessage(message: string) {
    const { setupLocalChoiceBox, setupLocalChoiceMessage } = this.options
    setupLocalChoiceMessage.content = message
    const mounted = setupLocalChoiceBox.getChildren().some((child) => child.id === setupLocalChoiceMessage.id)
    if (message) {
      if (!mounted) setupLocalChoiceBox.add(setupLocalChoiceMessage, 3)
    } else if (mounted) {
      setupLocalChoiceBox.remove(setupLocalChoiceMessage.id)
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

  #setPairSetupMessage(message: string, error: boolean) {
    const { setupPairForm, setupPairMessage } = this.options
    setupPairMessage.content = message
    setupPairMessage.fg = error ? colors.pink : colors.muted
    const mounted = setupPairForm.getChildren().some((child) => child.id === setupPairMessage.id)
    if (message) {
      if (!mounted) setupPairForm.add(setupPairMessage, 4)
    } else if (mounted) {
      setupPairForm.remove(setupPairMessage.id)
    }
    this.options.renderer.requestRender()
  }
}

function stopKey(key: SetupKey) {
  key.preventDefault()
  key.stopPropagation()
}
