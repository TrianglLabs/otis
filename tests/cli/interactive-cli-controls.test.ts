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

describe("CLI themes", () => {
  it("persists a selected theme and confirms that restart applies it", async () => {
    await loadCli()
    await submit("/theme nord")

    expect(mocks.saveSelectedTheme).toHaveBeenCalledWith("nord")
    expect(mocks.ui.setTheme).toHaveBeenCalled()
    expect(mocks.ui.renderTranscript.mock.calls.at(-1)?.[1]).toBeUndefined()
  })

  it("restores the selected theme when saving a preview fails", async () => {
    mocks.saveSelectedTheme.mockRejectedValueOnce(new Error("disk full"))
    await loadCli()

    mocks.uiOptions?.onPreviewTheme?.("nord")
    await submit("/theme nord")

    expect(mocks.saveSelectedTheme).toHaveBeenCalledWith("nord")
    expect(mocks.ui.setTheme.mock.calls.at(-1)?.[0]).toBe("default")
  })
})
