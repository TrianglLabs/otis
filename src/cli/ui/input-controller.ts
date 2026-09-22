import {
  BoxRenderable,
  type InputRenderable,
  InputRenderableEvents,
  MouseButton,
  TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import { colorPulseAmount, SelectionPulse, selectionOutline } from "./color-pulse.js"
import type { UILayout } from "./layout.js"
import {
  type InputMode,
  type PairEndpointInputs,
  type Renderer,
  type SetupInferenceChoice,
  type SetupInputCancelTarget,
  type SetupLocalInferenceChoice,
  stopKey,
  type UIKey,
} from "./types.js"

type InputControllerOptions = {
  renderer: Renderer
  layout: UILayout
  configured: boolean
  localInferenceUnavailableReason?: string
  onBeforePrimaryInput: () => void
  onModeChange?: (mode: InputMode) => void
  onSetup?: () => void
  onSetupInferenceChoice?: (choice: SetupInferenceChoice) => void
  onSetupLocalInferenceChoice?: (choice: SetupLocalInferenceChoice) => void
  onSetupSubmit?: (value: string) => void
  onPairSetupSubmit?: (endpoints: PairEndpointInputs) => void
}

/**
 * Swaps the composer between the chat textarea and the setup screens, and drives the setup
 * keyboard flow.
 */
export class InputController {
  mode: InputMode
  #setupInferenceChoice: SetupInferenceChoice = "local"
  #setupLocalInferenceChoice: SetupLocalInferenceChoice = "managed"
  #setupInputCancelTarget: SetupInputCancelTarget = "choice"
  readonly #setupChoicePulse: SelectionPulse
  readonly #layout: UILayout
  readonly #pairInputs: InputRenderable[]
  readonly #primaries: BoxRenderable[]

  constructor(private readonly options: InputControllerOptions) {
    const layout = options.layout
    this.#layout = layout
    this.mode = options.configured ? "chat" : "setupButton"
    if (options.localInferenceUnavailableReason) this.#setupLocalInferenceChoice = "pair"
    this.#pairInputs = [
      layout.setupPairOllamaInput,
      layout.setupPairLMStudioInput,
      ...(layout.setupOmlxInput ? [layout.setupOmlxInput] : []),
      ...(layout.setupOmlxKeyInput ? [layout.setupOmlxKeyInput] : []),
    ]
    this.#primaries = [
      layout.inputBox,
      layout.setupButtonBox,
      layout.setupChoiceBox,
      layout.setupLocalChoiceBox,
      layout.setupForm,
      layout.setupPairForm,
      layout.setupStatusBox,
    ]
    this.#setupChoicePulse = new SelectionPulse(options.renderer, (elapsed) =>
      this.#paintChoiceCards(elapsed),
    )
    layout.setupInput.on(InputRenderableEvents.ENTER, () => this.#submitSetup())
    for (const input of this.#pairInputs)
      input.on(InputRenderableEvents.ENTER, () => this.#submitPairSetup())
    bindAccentButton(layout.setupStartButton, options.renderer, () => options.onSetup?.())
    bindAccentButton(layout.setupContinueButton, options.renderer, () => this.#submitSetup())
    bindAccentButton(layout.setupLocalCard, options.renderer, () =>
      this.#selectInferenceChoice("local"),
    )
    bindAccentButton(layout.setupHostedCard, options.renderer, () =>
      this.#selectInferenceChoice("hosted"),
    )
    bindAccentButton(layout.setupManagedLocalCard, options.renderer, () =>
      this.#selectLocalInferenceChoice("managed"),
    )
    bindAccentButton(layout.setupPairCard, options.renderer, () =>
      this.#selectLocalInferenceChoice("pair"),
    )
  }

  handleKey(key: UIKey) {
    const enter = key.name === "return" || key.name === "enter"
    const arrow = ["left", "right", "up", "down"].includes(key.name)
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
      const fields = this.#pairInputs
      const current = fields.findIndex((field) => field.focused)
      this.#focusPairInput((current + (key.shift ? fields.length - 1 : 1)) % fields.length)
      return true
    }
    if (this.mode === "setupButton") {
      if (!enter) return false
      stopKey(key)
      this.options.onSetup?.()
      return true
    }
    if (this.mode === "setupChoice" && arrow) {
      stopKey(key)
      this.#setupInferenceChoice = key.name === "left" || key.name === "up" ? "local" : "hosted"
      this.#paintChoiceCards()
      this.options.renderer.requestRender()
      return true
    }
    if (this.mode === "setupChoice" && enter) {
      stopKey(key)
      this.options.onSetupInferenceChoice?.(this.#setupInferenceChoice)
      return true
    }
    if (this.mode === "setupChoice" && key.name === "escape") {
      stopKey(key)
      this.#clearSetupInput()
      this.mode = "setupButton"
      this.#layout.welcomeQuit.content = " "
      this.#setPrimary(this.#layout.setupButtonBox)
      return true
    }
    if (this.mode === "setupLocalChoice" && arrow) {
      stopKey(key)
      const managed = key.name === "left" || key.name === "up"
      this.#setupLocalInferenceChoice =
        managed && !this.options.localInferenceUnavailableReason ? "managed" : "pair"
      this.#paintChoiceCards()
      this.options.renderer.requestRender()
      return true
    }
    if (this.mode === "setupLocalChoice" && enter) {
      stopKey(key)
      this.options.onSetupLocalInferenceChoice?.(this.#setupLocalInferenceChoice)
      return true
    }
    if (this.mode === "setupLocalChoice" && key.name === "escape") {
      stopKey(key)
      this.showSetupInferenceChoice()
      return true
    }
    return false
  }

  clear() {
    this.#layout.input.clear()
    this.#clearSetupInput()
  }

  focus() {
    if (this.mode === "chat") this.#layout.input.focus()
    if (this.mode === "setupInput") this.#layout.setupInput.focus()
    if (this.mode === "setupPairInput") this.#focusPairInput(0)
  }

  setConfigured() {
    this.#clearSetupInput()
    this.mode = "chat"
    this.#layout.welcomeQuit.content = "/ for commands"
    this.#setPrimary(this.#layout.inputBox)
    this.focus()
  }

  showSetupInferenceChoice(message = "") {
    this.#clearSetupInput()
    this.mode = "setupChoice"
    this.#layout.welcomeQuit.content = " "
    this.#setMessage(this.#layout.setupChoiceBox, this.#layout.setupChoiceMessage, message, 3)
    this.#setPrimary(this.#layout.setupChoiceBox)
    this.#setupChoicePulse.start()
  }

  showSetupLocalInferenceChoice(message = "") {
    this.#clearSetupInput()
    this.mode = "setupLocalChoice"
    this.#layout.welcomeQuit.content = " "
    this.#setLocalChoiceMessage(message || this.options.localInferenceUnavailableReason || "")
    this.#setPrimary(this.#layout.setupLocalChoiceBox)
    this.#setupChoicePulse.start()
  }

  showSetup(message = "", cancelTarget: SetupInputCancelTarget = "choice", error = false) {
    this.#clearSetupInput()
    this.#setupInputCancelTarget = cancelTarget
    this.mode = "setupInput"
    this.#layout.setupInputLabel.content = "Fireworks API key"
    this.#layout.welcomeQuit.content = " "
    this.#setMessage(this.#layout.setupForm, this.#layout.setupMessage, message, 1, error)
    this.#setPrimary(this.#layout.setupForm)
    this.focus()
  }

  showPairSetup(
    message: string,
    cancelTarget: SetupInputCancelTarget,
    endpoints: PairEndpointInputs,
    error = false,
  ) {
    const layout = this.#layout
    this.#clearSetupInput()
    this.#setupInputCancelTarget = cancelTarget
    this.mode = "setupPairInput"
    layout.setupPairOllamaInput.value = endpoints.ollama
    layout.setupPairLMStudioInput.value = endpoints.lmStudio
    if (layout.setupOmlxInput) layout.setupOmlxInput.value = endpoints.omlx ?? ""
    if (layout.setupOmlxKeyInput) layout.setupOmlxKeyInput.value = endpoints.omlxApiKey ?? ""
    layout.welcomeQuit.content = " "
    this.#setMessage(layout.setupPairForm, layout.setupPairMessage, message, 6, error)
    this.#setPrimary(layout.setupPairForm)
    this.focus()
  }

  showSetupStatus(message = "Loading models...") {
    this.#clearSetupInput()
    this.mode = "setupStatus"
    this.#layout.setupStatus.content = message
    this.#layout.welcomeQuit.content = " "
    this.#setPrimary(this.#layout.setupStatusBox)
  }

  hideSetupStatus() {
    if (this.mode !== "setupStatus") return
    this.mode = "inactive"
    this.#layout.inputArea.remove(this.#layout.setupStatusBox.id)
    this.options.renderer.requestRender()
  }

  #setPrimary(renderable: BoxRenderable) {
    this.options.onBeforePrimaryInput()
    this.options.onModeChange?.(this.mode)
    if (renderable !== this.#layout.setupChoiceBox) this.#setupChoicePulse.stop()
    this.#layout.input.blur()
    this.#layout.setupInput.blur()
    for (const input of this.#pairInputs) input.blur()
    for (const primary of this.#primaries) this.#layout.inputArea.remove(primary.id)
    this.#layout.inputArea.add(renderable, 0)
    this.options.renderer.requestRender()
  }

  #clearSetupInput() {
    this.#layout.setupInput.value = ""
    for (const input of this.#pairInputs) input.value = ""
  }

  #submitSetup() {
    if (this.mode !== "setupInput") return
    this.options.onSetupSubmit?.(this.#layout.setupInput.value)
  }

  #submitPairSetup() {
    if (this.mode !== "setupPairInput") return
    const { setupPairOllamaInput, setupPairLMStudioInput, setupOmlxInput, setupOmlxKeyInput } =
      this.#layout
    this.options.onPairSetupSubmit?.({
      ollama: setupPairOllamaInput.value,
      lmStudio: setupPairLMStudioInput.value,
      ...(setupOmlxInput ? { omlx: setupOmlxInput.value } : {}),
      ...(setupOmlxKeyInput ? { omlxApiKey: setupOmlxKeyInput.value } : {}),
    })
  }

  #focusPairInput(index: number) {
    for (const field of this.#pairInputs) field.blur()
    this.#pairInputs[index].focus()
    this.options.renderer.requestRender()
  }

  #selectInferenceChoice(choice: SetupInferenceChoice) {
    if (this.mode !== "setupChoice") return
    this.#setupInferenceChoice = choice
    this.#paintChoiceCards()
    this.options.renderer.requestRender()
    this.options.onSetupInferenceChoice?.(choice)
  }

  #selectLocalInferenceChoice(choice: SetupLocalInferenceChoice) {
    if (this.mode !== "setupLocalChoice") return
    if (choice === "managed" && this.options.localInferenceUnavailableReason) {
      this.#setupLocalInferenceChoice = "pair"
      this.#setLocalChoiceMessage(this.options.localInferenceUnavailableReason)
      this.#paintChoiceCards()
      return
    }
    this.#setupLocalInferenceChoice = choice
    this.#paintChoiceCards()
    this.options.renderer.requestRender()
    this.options.onSetupLocalInferenceChoice?.(choice)
  }

  /**
   * Pulses the selected card's outline; only the mounted choice box is visible, so painting all
   * four is harmless.
   */
  #paintChoiceCards(elapsedMs = this.#setupChoicePulse.elapsed()) {
    const outline = selectionOutline(colorPulseAmount(elapsedMs))
    const { setupLocalCard, setupHostedCard, setupManagedLocalCard, setupPairCard } = this.#layout
    setupLocalCard.borderColor = this.#setupInferenceChoice === "local" ? outline : colors.border
    setupHostedCard.borderColor = this.#setupInferenceChoice === "hosted" ? outline : colors.border
    setupManagedLocalCard.borderColor =
      this.#setupLocalInferenceChoice === "managed" ? outline : colors.border
    setupPairCard.borderColor = this.#setupLocalInferenceChoice === "pair" ? outline : colors.border
  }

  #setLocalChoiceMessage(message: string) {
    this.#setMessage(
      this.#layout.setupLocalChoiceBox,
      this.#layout.setupLocalChoiceMessage,
      message,
      3,
    )
  }

  /**
   * Mounts `label` at `index` in `box` while there is a message, and unmounts it when the message
   * is empty.
   */
  #setMessage(
    box: BoxRenderable,
    label: TextRenderable,
    message: string,
    index: number,
    error?: boolean,
  ) {
    label.content = message
    if (error !== undefined) label.fg = error ? colors.pink : colors.muted
    const mounted = box.getChildren().some((child) => child.id === label.id)
    if (message && !mounted) box.add(label, index)
    else if (!message && mounted) box.remove(label.id)
    this.options.renderer.requestRender()
  }
}

function bindAccentButton(button: BoxRenderable, renderer: Renderer, action: () => void) {
  const activate = (event: { button: number; preventDefault(): void; stopPropagation(): void }) => {
    if (event.button !== MouseButton.LEFT) return
    event.preventDefault()
    event.stopPropagation()
    action()
  }
  const bind = (node: BoxRenderable | TextRenderable) => {
    node.onMouseDown = activate
    node.onMouseOver = () => renderer.setMousePointer("pointer")
    node.onMouseOut = () => renderer.setMousePointer("default")
    if (!(node instanceof BoxRenderable)) return
    for (const child of node.getChildren()) {
      if (child instanceof BoxRenderable || child instanceof TextRenderable) bind(child)
    }
  }
  bind(button)
}
