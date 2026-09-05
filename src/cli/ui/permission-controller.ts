import type { BoxRenderable, TextRenderable } from "@opentui/core"
import type { Renderer } from "./types.js"

type PermissionControllerOptions = {
  renderer: Renderer
  inputArea: BoxRenderable
  prompt: BoxRenderable
  label: TextRenderable
}

type PermissionKey = {
  name: string
  preventDefault(): void
  stopPropagation(): void
}

export class PermissionController {
  private visible = false
  private resolve: ((approved: boolean) => void) | undefined

  constructor(private readonly options: PermissionControllerOptions) {}

  get isVisible() {
    return this.visible
  }

  show(detail: string): Promise<boolean> {
    this.options.label.content = detail
    if (!this.visible) {
      this.options.inputArea.add(this.options.prompt)
      this.visible = true
    }
    this.options.renderer.requestRender()
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve
    })
  }

  hide() {
    this.finish(false)
  }

  handleKey(key: PermissionKey) {
    if (!this.visible) return false
    if (key.name === "y") {
      stopKey(key)
      this.finish(true)
      return true
    }
    if (key.name === "n" || key.name === "escape") {
      stopKey(key)
      this.finish(false)
      return true
    }
    return false
  }

  private finish(approved: boolean) {
    const resolve = this.resolve
    if (this.visible) {
      this.options.inputArea.remove(this.options.prompt.id)
      this.visible = false
      this.options.renderer.requestRender()
    }
    this.resolve = undefined
    resolve?.(approved)
  }
}

function stopKey(key: PermissionKey) {
  key.preventDefault()
  key.stopPropagation()
}
