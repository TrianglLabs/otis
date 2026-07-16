import { getTreeSitterClient, type TreeSitterClient } from "@opentui/core"

type Renderer = Awaited<ReturnType<typeof import("@opentui/core").createCliRenderer>>

const WAKE_CHECK_INTERVAL_MS = 5_000
const WAKE_REPAINT_THRESHOLD_MS = 15_000

export class TerminalController {
  #focused = true

  constructor(
    private readonly renderer: Renderer,
    private readonly isExiting: () => boolean,
    private readonly focusInput: () => void,
  ) {}

  installRecovery() {
    let lastWakeCheck = Date.now()
    const onFocus = () => {
      this.#focused = true
      this.repaint()
    }
    const onBlur = () => {
      this.#focused = false
    }
    const wakeCheck = setInterval(() => {
      const now = Date.now()
      if (now - lastWakeCheck > WAKE_REPAINT_THRESHOLD_MS) this.repaint()
      lastWakeCheck = now
    }, WAKE_CHECK_INTERVAL_MS)
    wakeCheck.unref?.()

    this.renderer.on("focus", onFocus)
    this.renderer.on("blur", onBlur)
    this.renderer.once("destroy", () => {
      clearInterval(wakeCheck)
      this.renderer.off("focus", onFocus)
      this.renderer.off("blur", onBlur)
    })
  }

  notifyCompletion() {
    if (!this.#focused && !this.isExiting()) process.stdout.write("\x07")
  }

  private repaint() {
    if (this.isExiting()) return

    try {
      this.renderer.resetSplitFooterForReplay({ clearSavedLines: false })
    } catch {
      this.renderer.requestRender()
    }

    setTimeout(() => {
      if (this.isExiting()) return
      this.renderer.requestRender()
      this.focusInput()
    }, 50).unref?.()
  }
}

export async function initializeTreeSitterClient(): Promise<TreeSitterClient | undefined> {
  try {
    const client = getTreeSitterClient()
    await client.initialize()
    return client
  } catch {
    return undefined
  }
}
