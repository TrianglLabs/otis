import { describe, expect, it } from "vitest"
import { getMocks, loadCli, localSettings, settle, submit, testModel } from "./support/interactive-cli-harness.js"

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

  it("applies a busy mode change to the next turn without changing the active turn policy", async () => {
    let releaseFirstTurn = () => {}
    const firstTurnReleased = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    let markFirstTurnStarted = () => {}
    const firstTurnStarted = new Promise<void>((resolve) => {
      markFirstTurnStarted = resolve
    })
    let activeEffectAfterToggle: string | undefined
    let nextEffect: string | undefined

    mocks.runAgent
      .mockImplementationOnce(async function* (_input, _history, options) {
        markFirstTurnStarted()
        await firstTurnReleased
        activeEffectAfterToggle = (
          await options.permissionPolicy.evaluate({ name: "bash", input: { command: "git status" } })
        ).effect
        yield { type: "complete", messages: [] }
      })
      .mockImplementationOnce(async function* (_input, _history, options) {
        nextEffect = (await options.permissionPolicy.evaluate({ name: "bash", input: { command: "git status" } }))
          .effect
        yield { type: "complete", messages: [] }
      })

    await loadCli()
    const firstTurn = submit("inspect")
    await firstTurnStarted

    mocks.uiOptions?.onToggleMode?.()
    expect(mocks.ui.setModeLabel).toHaveBeenLastCalledWith("? ask")

    releaseFirstTurn()
    await firstTurn
    await submit("inspect again")

    expect(activeEffectAfterToggle).toBe("allow")
    expect(nextEffect).toBe("ask")
  })

  it("honors an explicitly configured ask default", async () => {
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ permissions: { defaultMode: "ask", rules: [] } }))

    await loadCli()

    expect(mocks.createChatUI.mock.calls.at(-1)?.[1]).toMatchObject({ modeLabel: "? ask" })
  })
})

describe("CLI settings", () => {
  it("moves debug mode into the settings submenu", async () => {
    await loadCli()

    const commands = mocks.createChatUI.mock.calls.at(-1)?.[1].commands ?? []
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "/settings" })]))
    expect(commands).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "/debug" })]))

    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu).toHaveBeenLastCalledWith(
      [
        {
          name: "Hosted inference",
          description: "Replace API key",
          submission: "/settings hosted",
        },
        {
          name: "Debug mode",
          description: "Off",
          submission: "/settings debug",
        },
      ],
      { onBack: expect.any(Function) },
    )
    const onBack = mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[1]?.onBack
    onBack?.()
    expect(mocks.ui.showSlashCommandMenu).toHaveBeenCalledOnce()

    await submit("/settings debug")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Debug mode on ")

    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Debug mode", description: "On" })]),
    )
  })

  it("opens model browsing immediately and defers the selected model until the turn finishes", async () => {
    let releaseTurn = () => {}
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    let markTurnStarted = () => {}
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve
    })
    mocks.runAgent.mockImplementationOnce(async function* () {
      markTurnStarted()
      await turnReleased
      yield { type: "complete", messages: [] }
    })

    await loadCli()
    const turn = submit("inspect")
    await turnStarted

    await submit("/settings")
    const settings = (mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0] ?? []) as Array<{ name: string }>
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Hosted inference" }),
        expect.objectContaining({ name: "Debug mode" }),
      ]),
    )

    await submit("/model")
    expect(mocks.listToolCapableModels).toHaveBeenCalled()
    expect(mocks.ui.showModelPicker).toHaveBeenCalled()
    const model = mocks.ui.showModelPicker.mock.calls
      .at(-1)?.[0]
      .find((item: { provider?: string }) => item.provider === "fireworks")
    expect(model).toBeDefined()
    mocks.uiOptions?.onSelectModel?.(model)
    await settle()
    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()

    releaseTurn()
    await turn
    expect(mocks.saveSelectedModel).toHaveBeenCalled()
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
        fastServingModels: [kimi.id],
      }),
    )
    await loadCli()

    await submit("/fast")
    expect(mocks.saveFastServingSelection).toHaveBeenCalledWith(kimi, false)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving off ")
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/fast" })]),
    )

    await submit("/fast")
    expect(mocks.saveFastServingSelection).toHaveBeenLastCalledWith({ ...kimi, id: kimi.fastId }, true)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3 Fast")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving on ")
  })

  it("leaves models without a Fast path unchanged", async () => {
    await loadCli()
    await submit("/fast")

    expect(mocks.saveFastServingSelection).not.toHaveBeenCalled()
    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Fast serving is not available for this model ")
    expect(mocks.ui.setCommands).not.toHaveBeenCalled()
  })

  it("remembers Fast serving independently for each model", async () => {
    const alpha = testModel({
      id: "accounts/fireworks/models/alpha",
      displayName: "Alpha",
      fastId: "accounts/fireworks/routers/alpha-fast",
    })
    const beta = testModel({
      id: "accounts/fireworks/models/beta",
      displayName: "Beta",
      fastId: "accounts/fireworks/routers/beta-fast",
    })
    mocks.listToolCapableModels.mockResolvedValue([alpha, beta])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: alpha.fastId,
        modelDisplayName: alpha.displayName,
        modelFastId: alpha.fastId,
        fastServingModels: [alpha.id],
      }),
    )
    await loadCli()

    await selectModel(beta.id)
    expect(mocks.saveSelectedModel).toHaveBeenLastCalledWith(beta)

    await submit("/fast")
    expect(mocks.saveFastServingSelection).toHaveBeenLastCalledWith({ ...beta, id: beta.fastId }, true)

    await selectModel(alpha.id)
    expect(mocks.saveSelectedModel).toHaveBeenLastCalledWith({ ...alpha, id: alpha.fastId })

    await submit("/fast")
    expect(mocks.saveFastServingSelection).toHaveBeenLastCalledWith(alpha, false)

    await selectModel(beta.id)
    expect(mocks.saveSelectedModel).toHaveBeenLastCalledWith({ ...beta, id: beta.fastId })
  })
})

async function selectModel(modelId: string) {
  await submit("/model")
  const items = mocks.ui.showModelPicker.mock.calls.at(-1)?.[0] ?? []
  const model = items.find((item: { id?: string }) => item.id === modelId)
  if (!model) throw new Error(`Missing model picker item: ${modelId}`)
  mocks.uiOptions?.onSelectModel?.(model)
  await settle()
}
