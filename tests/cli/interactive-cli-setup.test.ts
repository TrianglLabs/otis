import { describe, expect, it } from "vitest"
import { getMocks, loadCli, localSettings, settle, submit, testModel } from "./support/interactive-cli-harness.js"

describe("interactive CLI setup", () => {
  const mocks = getMocks()

  it("stores verified Fireworks setup and a local Parallel key before enabling chat", async () => {
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
    expect(mocks.ui.showModelPicker).toHaveBeenCalledWith([
      expect.objectContaining({ id: "accounts/fireworks/models/test-model", active: false }),
    ])

    mocks.uiOptions?.onSelectModel?.(testModel())
    await settle()
    expect(mocks.saveFireworksSetup).toHaveBeenCalledWith("fw_new_key", testModel())
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Test Model")
    expect(mocks.ui.showSetupInput).toHaveBeenLastCalledWith("parallel", expect.stringContaining("Web search"))
    expect(mocks.openProviderKeyPage).toHaveBeenCalledWith("parallel")
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()

    mocks.uiOptions?.onSetupSubmit?.("parallel", "parallel_new_key")
    await settle()
    expect(mocks.saveParallelApiKey).toHaveBeenCalledWith("parallel_new_key")
    expect(mocks.ui.setConfigured).toHaveBeenCalledOnce()
    expect(mocks.ui.setModelLabel).toHaveBeenCalledWith("Test Model")
  })

  it("uses an environment key without copying it into the config file", async () => {
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
    mocks.uiOptions?.onSelectModel?.(testModel())
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(testModel())
    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
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
