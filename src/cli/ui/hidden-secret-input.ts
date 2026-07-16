import type { InputRenderable, KeyEvent, PasteEvent } from "@opentui/core"

export class HiddenSecretInput {
  #value = ""

  constructor(
    input: InputRenderable,
    private readonly isActive: () => boolean,
  ) {
    input.onKeyDown = (key) => this.handleKey(key)
    input.onPaste = (event) => this.handlePaste(event)
  }

  get value() {
    return this.#value
  }

  clear() {
    this.#value = ""
  }

  private handleKey(key: KeyEvent) {
    if (!this.isActive()) return

    if (key.name.length === 1 && !key.ctrl && !key.meta && !key.option && !key.super) {
      key.preventDefault()
      const code = key.name.charCodeAt(0)
      if (code >= 32 && code <= 126) this.#value += key.name
      return
    }

    if (key.name.length === 2 && !key.ctrl && !key.meta && !key.option && !key.super) {
      key.preventDefault()
      return
    }

    if (key.name === "backspace" && !key.ctrl && !key.meta) {
      key.preventDefault()
      this.#value = this.#value.slice(0, -1)
      return
    }

    if (key.ctrl && key.name === "u") {
      key.preventDefault()
      this.clear()
    }
  }

  private handlePaste(event: PasteEvent) {
    if (!this.isActive()) return
    event.preventDefault()

    for (const char of new TextDecoder().decode(event.bytes)) {
      if (char === "\n" || char === "\r") continue
      const code = char.charCodeAt(0)
      if (code >= 32 && code <= 126) this.#value += char
    }
  }
}
