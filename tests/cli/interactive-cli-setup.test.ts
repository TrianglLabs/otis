import { describe, expect, it } from "vitest"
import { getMocks, loadCli, localSettings, settle, submit, testModel } from "./support/interactive-cli-harness.js"

describe("interactive CLI setup", () => {
  const mocks = getMocks()

  it("automatically selects Muse Glimmer and enables chat after the Fireworks key", async () => {
    const fallback = testModel({
      id: "accounts/fireworks/models/fallback",
      displayName: "Fallback",
    })
    const inkling = testModel({
      id: "accounts/fireworks/models/inkling",
      displayName: "Inkling",
    })
    const muse = testModel({
      id: "accounts/fireworks/models/muse-glimmer-30b",
      displayName: "Muse Glimmer 30B",
    })
    mocks.listToolCapableModels.mockResolvedValue([fallback, inkling, muse])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()

    expect(mocks.uiOptions?.configured).toBe(false)
    expect(mocks.uiOptions?.statsVisible).toBe(false)
    expect(mocks.uiOptions?.modelLabel).toBe("")
    expect(mocks.calculateLocalStats).not.toHaveBeenCalled()
    mocks.uiOptions?.onSetup?.()
    expect(mocks.ui.showSetupInput).toHaveBeenCalledOnce()
    expect(mocks.openFireworksKeyPage).toHaveBeenCalledOnce()

    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()
    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_new_key")
    expect(mocks.ui.showModelPicker).not.toHaveBeenCalled()
    expect(mocks.saveFireworksSetup).toHaveBeenCalledWith("fw_new_key", muse)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Muse Glimmer 30B")
    expect(mocks.ui.setConfigured).toHaveBeenCalledOnce()
    expect(mocks.ParallelClient).toHaveBeenCalledOnce()
  })

  it("falls back to Inkling and does not copy an environment key into the config file", async () => {
    const fallback = testModel({
      id: "accounts/fireworks/models/fallback",
      displayName: "Fallback",
    })
    const inkling = testModel({
      id: "accounts/fireworks/models/inkling",
      displayName: "Inkling",
    })
    mocks.listToolCapableModels.mockResolvedValue([fallback, inkling])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: "fw_env_key",
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()
    await settle()

    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_env_key")
    expect(mocks.ui.showModelPicker).not.toHaveBeenCalled()
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(inkling)
    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.ui.setConfigured).toHaveBeenCalledOnce()
    expect(mocks.ParallelClient).toHaveBeenCalledOnce()
  })

  it("uses the first verified model when neither preferred default is available", async () => {
    const first = testModel({
      id: "accounts/fireworks/models/first-verified",
      displayName: "First Verified",
    })
    mocks.listToolCapableModels.mockResolvedValue([first, testModel()])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: "fw_env_key",
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )

    await loadCli()
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(first)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("First Verified")
  })

  it("keeps setup disabled when Fireworks has no verified tool-capable model", async () => {
    mocks.listToolCapableModels.mockResolvedValue([])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()

    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.ui.showSetupError).toHaveBeenCalledWith(
      "Fireworks returned no public serverless models with tool support.",
    )
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()
  })

  it("does not enable chat when saving the automatic model selection fails", async () => {
    mocks.saveFireworksSetup.mockRejectedValueOnce(new Error("Could not save Fireworks setup."))
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()

    expect(mocks.ui.showSetupError).toHaveBeenCalledWith("Could not save Fireworks setup.")
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()
  })

  it("enables chat when Fireworks and a model are already configured", async () => {
    mocks.loadLocalSettings.mockResolvedValue(localSettings())
    await loadCli()

    expect(mocks.uiOptions?.configured).toBe(true)
    expect(mocks.uiOptions?.statsVisible).toBe(true)
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalled()
    expect(mocks.ParallelClient).toHaveBeenCalledOnce()
    expect(commandNames()).not.toContain("/fast")
  })

  it("advertises /fast when the saved model has a Fast serving path", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: "accounts/fireworks/models/kimi-k3",
        modelDisplayName: "Kimi K3",
        modelFastId: "accounts/fireworks/routers/kimi-k3-fast",
        fastMode: false,
      }),
    )
    await loadCli()
    expect(commandNames()).toContain("/fast")
  })

  it("opens the verified model catalog from the model command", async () => {
    const replacement = testModel({
      id: "accounts/fireworks/models/replacement",
      displayName: "Replacement",
    })
    mocks.listToolCapableModels.mockResolvedValue([replacement])
    await loadCli()

    mocks.ui.showSetupStatus.mockClear()
    mocks.ui.showChatLayout.mockClear()

    await submit("/model")

    expect(mocks.ui.clearInput).toHaveBeenCalled()
    expect(mocks.ui.showChatLayout).toHaveBeenCalled()
    expect(mocks.ui.showSetupStatus).not.toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).toHaveBeenCalledWith(" Loading models… ")
    expect(mocks.ui.showModelPicker).toHaveBeenCalledWith([{ ...replacement, active: false }])
  })

  it("uses the Fast serving path when the selected catalog model has one", async () => {
    const kimi = testModel({
      id: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      fastId: "accounts/fireworks/routers/kimi-k3-fast",
      supportsImageInput: true,
    })
    mocks.listToolCapableModels.mockResolvedValue([kimi])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: "fw_env_key",
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )

    await loadCli()
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith({
      ...kimi,
      id: "accounts/fireworks/routers/kimi-k3-fast",
    })
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3 Fast")
    expect(mocks.FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/routers/kimi-k3-fast" }),
    )
  })

  it("marks the catalog row active when the saved model is its Fast serving path", async () => {
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
    await submit("/model")

    expect(mocks.ui.showModelPicker).toHaveBeenCalledWith([{ ...kimi, active: true }])
  })

  it("saves the Fast serving path when a labeled catalog model is selected", async () => {
    const kimi = testModel({
      id: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      fastId: "accounts/fireworks/routers/kimi-k3-fast",
    })
    mocks.listToolCapableModels.mockResolvedValue([kimi])
    await loadCli()
    await submit("/model")

    mocks.uiOptions?.onSelectModel?.(kimi)
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith({
      ...kimi,
      id: "accounts/fireworks/routers/kimi-k3-fast",
    })
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3 Fast")
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/fast" })]),
    )
  })

  it("saves the catalog model when Fast mode is off", async () => {
    const kimi = testModel({
      id: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      fastId: "accounts/fireworks/routers/kimi-k3-fast",
    })
    mocks.listToolCapableModels.mockResolvedValue([kimi])
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ fastMode: false }))
    await loadCli()
    await submit("/model")

    mocks.uiOptions?.onSelectModel?.(kimi)
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(kimi)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3")
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/fast" })]),
    )
  })
})

function commandNames() {
  const commands = getMocks().createChatUI.mock.calls.at(-1)?.[1]?.commands as Array<{ name: string }> | undefined
  return commands?.map((command) => command.name) ?? []
}
