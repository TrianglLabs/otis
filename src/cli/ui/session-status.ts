import { fg, type TextRenderable, t } from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

export class SessionStatus {
  private label: string
  private added = 0
  private removed = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly renderable: TextRenderable,
    initialLabel: string,
  ) {
    this.label = initialLabel
  }

  setLabel(label: string) {
    this.label = label
    this.render()
  }

  setDiff(added: number, removed: number) {
    this.added = added
    this.removed = removed
    this.render()
  }

  private render() {
    this.renderable.content =
      this.added > 0 || this.removed > 0
        ? t`${this.label}  ${fg(colors.green)(`+${this.added}`)} ${fg(colors.pink)(`−${this.removed}`)}`
        : this.label
    this.renderer.requestRender()
  }
}
