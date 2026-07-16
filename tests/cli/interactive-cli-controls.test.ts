import { describe, expect, it } from "vitest"
import { getMocks, loadCli, submit } from "./support/interactive-cli-harness.js"

const mocks = getMocks()

describe("CLI interrupt", () => {
  it("aborts the active turn when onInterrupt is called", async () => {
    const signals: AbortSignal[] = []
    let resolveStart: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve
    })

    mocks.runAgent.mockImplementationOnce(async function* (_input, _history, options) {
      if (options?.signal) signals.push(options.signal)
      resolveStart()
      yield { type: "model", phase: "start" }
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (!options?.signal?.aborted) {
        yield { type: "complete", messages: [] }
      }
    })

    await loadCli()
    void submit("test")
    await started

    expect(mocks.uiOptions?.onInterrupt).toBeDefined()
    expect(signals[0]?.aborted).toBe(false)

    mocks.uiOptions?.onInterrupt?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(signals[0]?.aborted).toBe(true)
  })

  it("resets busy state when session admission fails", async () => {
    mocks.createSession.mockRejectedValue(new Error("disk full"))

    await loadCli()
    await submit("test")

    expect(mocks.ui.setBusy).toHaveBeenCalledWith(true)
    expect(mocks.ui.setBusy).toHaveBeenCalledWith(false)
  })
})

describe("CLI mode toggle", () => {
  it("cycles mode label on toggle", async () => {
    await loadCli()

    mocks.uiOptions?.onToggleMode?.()
    expect(mocks.ui.setModeLabel).toHaveBeenCalledWith("? ask")

    mocks.uiOptions?.onToggleMode?.()
    expect(mocks.ui.setModeLabel).toHaveBeenCalledWith("› auto")
  })
})
