import { describe, expect, it } from "vitest"
import { getMocks, loadCli, localSettings, settle, submit, testModel } from "./support/interactive-cli-harness.js"

describe("interactive CLI setup", () => {
  const mocks = getMocks()

  it("automatically selects Muse Glimmer and stores both provider keys before enabling chat", async () => {
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
        parallelApiKey: undefined,
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
    expect(mocks.ui.showSetupInput).toHaveBeenCalledWith("fireworks", expect.stringContaining("Inference"))
    expect(mocks.openProviderKeyPage).toHaveBeenCalledWith("fireworks")

    mocks.uiOptions?.onSetupSubmit?.("fireworks", "fw_new_key")
    await settle()
    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_new_key")
    expect(mocks.ui.showModelPicker).not.toHaveBeenCalled()
    expect(mocks.saveFireworksSetup).toHaveBeenCalledWith("fw_new_key", muse)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Muse Glimmer 30B")
    expect(mocks.ui.showSetupInput).toHaveBeenLastCalledWith("parallel", expect.stringContaining("Web search"))
    expect(mocks.openProviderKeyPage).toHaveBeenCalledWith("parallel")
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()

    mocks.uiOptions?.onSetupSubmit?.("parallel", "parallel_new_key")
    await settle()
    expect(mocks.saveParallelApiKey).toHaveBeenCalledWith("parallel_new_key")
    expect(mocks.ui.setConfigured).toHaveBeenCalledOnce()
    expect(mocks.ui.setModelLabel).toHaveBeenCalledWith("Muse Glimmer 30B")
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
        parallelApiKey: "parallel_env_key",
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
        parallelApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupSubmit?.("fireworks", "fw_new_key")
    await settle()

    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalledWith("parallel", expect.any(String))
    expect(mocks.ui.showSetupError).toHaveBeenCalledWith(
      "Fireworks returned no public serverless models with tool support.",
    )
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()
  })

  it("does not advance to Parallel when saving the automatic model selection fails", async () => {
    mocks.saveFireworksSetup.mockRejectedValueOnce(new Error("Could not save Fireworks setup."))
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        parallelApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
      }),
    )
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupSubmit?.("fireworks", "fw_new_key")
    await settle()

    expect(mocks.ui.showSetupError).toHaveBeenCalledWith("Could not save Fireworks setup.")
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalledWith("parallel", expect.any(String))
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()
  })

  it("asks only for Parallel when Fireworks and a model are already configured", async () => {
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ parallelApiKey: undefined }))
    await loadCli()

    expect(mocks.uiOptions?.configured).toBe(false)
    expect(mocks.uiOptions?.statsVisible).toBe(true)
    expect(mocks.ui.showSetupInput).toHaveBeenCalledWith("parallel", expect.stringContaining("platform.parallel.ai"))
    expect(mocks.openProviderKeyPage).toHaveBeenCalledWith("parallel")

    mocks.uiOptions?.onSetupSubmit?.("parallel", "parallel_new_key")
    await settle()

    expect(mocks.saveParallelApiKey).toHaveBeenCalledWith("parallel_new_key")
    expect(mocks.ui.setConfigured).toHaveBeenCalledOnce()
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
})
