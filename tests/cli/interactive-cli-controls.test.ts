import { describe, expect, it } from "vitest"
import { getMocks, loadCli, localSettings, submit, testModel } from "./support/interactive-cli-harness.js"

const mocks = getMocks()

describe("CLI interrupt", () => {
  it("aborts the active turn when onInterrupt is called", async () => {
    let signal: AbortSignal | undefined
    let resolveStart: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve
    })
    let resolveAbort: () => void = () => {}
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve
    })

    mocks.runAgent.mockImplementationOnce(async function* (_input, _history, options) {
      signal = options?.signal
      signal?.addEventListener("abort", () => resolveAbort(), { once: true })
      resolveStart()
      yield { type: "model", phase: "start" }
      await aborted
    })

    await loadCli()
    void submit("test")
    await started

    expect(signal?.aborted).toBe(false)
    mocks.uiOptions?.onInterrupt?.()
    await aborted

    expect(signal?.aborted).toBe(true)
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
  it("starts in auto mode and passes the shared policy to the agent", async () => {
    mocks.runAgent.mockImplementationOnce(async function* (_input, _history, options) {
      expect((await options.permissionPolicy.evaluate({ name: "bash", input: { command: "git status" } })).effect).toBe(
        "allow",
      )
      yield { type: "complete", messages: [] }
    })

    await loadCli()
    await submit("inspect")

    expect(mocks.createChatUI.mock.calls.at(-1)?.[1]).toMatchObject({ modeLabel: "› auto" })
  })

  it("cycles mode label on toggle", async () => {
    await loadCli()

    mocks.uiOptions?.onToggleMode?.()
    expect(mocks.ui.setModeLabel).toHaveBeenCalledWith("? ask")

    mocks.uiOptions?.onToggleMode?.()
    expect(mocks.ui.setModeLabel).toHaveBeenCalledWith("› auto")
  })

  it("honors an explicitly configured ask default", async () => {
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ permissions: { defaultMode: "ask", rules: [] } }))

    await loadCli()

    expect(mocks.createChatUI.mock.calls.at(-1)?.[1]).toMatchObject({ modeLabel: "? ask" })
  })
})

describe("CLI themes", () => {
  it("persists a selected theme without adding a transcript message", async () => {
    await loadCli()
    const transcriptRenderCount = mocks.ui.renderTranscript.mock.calls.length
    await submit("/theme nord")

    expect(mocks.saveSelectedTheme).toHaveBeenCalledWith("nord")
    expect(mocks.ui.setTheme).toHaveBeenCalled()
    expect(mocks.ui.renderTranscript).toHaveBeenCalledTimes(transcriptRenderCount)
    expect(mocks.ui.clearInput).toHaveBeenCalled()
    expect(mocks.ui.focusInput).toHaveBeenCalled()
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

describe("CLI thinking visibility", () => {
  it("persists each thinking visibility toggle", async () => {
    await loadCli()

    await submit("/thinking")
    expect(mocks.saveThinkingVisible).toHaveBeenCalledWith(true)
    expect(mocks.ui.setThinkingVisible).toHaveBeenLastCalledWith(true)
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Thinking traces shown ")

    await submit("/thinking")
    expect(mocks.saveThinkingVisible).toHaveBeenLastCalledWith(false)
    expect(mocks.ui.setThinkingVisible).toHaveBeenLastCalledWith(false)
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Thinking traces hidden ")
  })
})

describe("CLI Fast serving", () => {
  it("toggles Fast serving for models that have a Fast path", async () => {
    const kimi = testModel({
      id: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      fastId: "accounts/fireworks/routers/kimi-k3-fast",
    })
    mocks.listToolCapableModels.mockResolvedValue([kimi])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: kimi.fastId,
        modelDisplayName: "Kimi K3",
      }),
    )
    await loadCli()

    await submit("/fast")
    expect(mocks.saveFastMode).toHaveBeenCalledWith(false)
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(kimi)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving off ")
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/fast" })]),
    )

    await submit("/fast")
    expect(mocks.saveFastMode).toHaveBeenLastCalledWith(true)
    expect(mocks.saveSelectedModel).toHaveBeenLastCalledWith({ ...kimi, id: kimi.fastId })
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3 Fast")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving on ")
  })

  it("leaves models without a Fast path unchanged", async () => {
    await loadCli()
    await submit("/fast")

    expect(mocks.saveFastMode).not.toHaveBeenCalled()
    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving is not available for this model ")
    expect(mocks.ui.setCommands).not.toHaveBeenCalled()
  })
})
