import { describe, expect, it, vi } from "vitest"
import { findLocalModel } from "../../src/inference/local-catalog.js"
import {
  type LocalPickerChoice,
  type ModelPickerItem,
  toFireworksPickerChoice,
} from "../../src/inference/picker-catalog.js"
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
    expect(mocks.uiOptions?.modelLabel).toBe("")
    expect(mocks.calculateLocalStats).not.toHaveBeenCalled()
    mocks.uiOptions?.onSetup?.()
    expect(mocks.ui.showSetupInput).toHaveBeenCalledOnce()
    expect(mocks.openFireworksKeyPage).toHaveBeenCalledOnce()

    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()
    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_new_key", {
      signal: expect.any(AbortSignal),
    })
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

    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_env_key", {
      signal: expect.any(AbortSignal),
    })
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
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalled()
    expect(mocks.ParallelClient).toHaveBeenCalledOnce()
    expect(commandNames()).not.toContain("/fast")
    expect(commandNames()).not.toContain("/delete-model")
  })

  it("shows home stats when a local model is configured without a Fireworks key", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: cached.id,
        modelDisplayName: cached.displayName,
        modelContextLength: 32_768,
        modelProvider: "local",
      }),
    )
    await loadCli()
    await settle()

    expect(mocks.uiOptions?.configured).toBe(true)
    expect(mocks.calculateLocalStats).toHaveBeenCalled()
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

  it("advertises local model deletion only when a model is downloaded", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])

    await loadCli()

    expect(commandNames()).toContain("/delete-model")
    await submit("/delete-model")
    expect(mocks.ui.showCommandSubmenu).toHaveBeenCalledWith([
      expect.objectContaining({
        name: cached.displayName,
        submission: `/delete-model ${cached.id}`,
      }),
    ])
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
    const picker = mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []
    expect(picker[0]).toMatchObject({ kind: "header", displayName: "Local" })
    expect(picker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...replacement, provider: "fireworks", active: false, available: true }),
      ]),
    )
  })

  it("still shows local models when Fireworks catalog discovery fails", async () => {
    mocks.listToolCapableModels.mockRejectedValue(new Error("invalid API key"))
    await loadCli()

    await submit("/model")

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(picker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "header", displayName: "Local" }),
        expect.objectContaining({ id: "openai/gpt-oss-20b", provider: "local" }),
      ]),
    )
    expect(picker).not.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "fireworks" })]))
    expect(mocks.ui.showSetupError).not.toHaveBeenCalled()
  })

  it("keeps the catalog serving path when Fast mode is unset", async () => {
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

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(kimi)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3")
    expect(mocks.FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/models/kimi-k3" }),
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

    expect(mocks.ui.showModelPicker).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ ...kimi, provider: "fireworks", active: true })]),
    )
  })

  it("saves the Fast serving path when Fast mode is on and a labeled catalog model is selected", async () => {
    const kimi = testModel({
      id: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      fastId: "accounts/fireworks/routers/kimi-k3-fast",
    })
    mocks.listToolCapableModels.mockResolvedValue([kimi])
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ fastMode: true }))
    await loadCli()
    await submit("/model")

    mocks.uiOptions?.onSelectModel?.(toFireworksPickerChoice(kimi))
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

    mocks.uiOptions?.onSelectModel?.(toFireworksPickerChoice(kimi))
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(kimi)
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Kimi K3")
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/fast" })]),
    )
  })

  it("starts the local server when a runnable catalog model is selected", async () => {
    await loadCli()
    await submit("/model")

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const local = picker.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")
    expect(local).toMatchObject({ provider: "local", available: true })
    if (!local) throw new Error("missing local picker item")
    mocks.uiOptions?.onSelectModel?.(local)
    await settle()

    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai/gpt-oss-20b", provider: "local", contextLength: 32_768 }),
    )
    expect(mocks.ensureLocalServing).toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).not.toHaveBeenCalledWith(expect.stringMatching(/Starting /))
    expect(mocks.ui.showHomeLayout).not.toHaveBeenCalled()
    expect(mocks.ui.setModelPickerStatus).toHaveBeenCalledWith("openai/gpt-oss-20b", "47%")
    expect(mocks.ui.setModelPickerStatus).toHaveBeenCalledWith("openai/gpt-oss-20b", "Loading")
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("gpt-oss 20B")
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith(expect.stringMatching(/%|loading/i))
    expect(mocks.ui.hideModelPicker).toHaveBeenCalled()
    expect(mocks.ui.setConfigured).toHaveBeenCalled()
    expect(mocks.ui.setCommands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/delete-model" })]),
    )

    mocks.ui.showModelPicker.mockClear()
    await submit("/model")
    const reopened = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(reopened.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")).toMatchObject({
      active: true,
      contextLength: 32_768,
      loadedContextLength: 32_768,
      availabilityLabel: expect.stringMatching(/^32K loaded · /),
    })
    expect(
      reopened
        .filter(
          (item): item is LocalPickerChoice =>
            item.kind === "model" && item.provider === "local" && item.id !== "openai/gpt-oss-20b",
        )
        .every((item) => item.availabilityLabel.startsWith("Up to ")),
    ).toBe(true)
  })

  it("deletes the final inactive local model and defensively stops llama.cpp", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])
    mocks.deleteLocalGguf.mockImplementationOnce(async () => {
      mocks.listDownloadedLocalModels.mockResolvedValue([])
    })
    await loadCli()
    await submit(`/delete-model ${cached.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(cached))

    expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
    expect(mocks.clearSelectedModel).not.toHaveBeenCalled()
    expect(latestCommandNames()).not.toContain("/delete-model")
  })

  it("deletes an inactive model without interrupting a different active local model", async () => {
    const active = findLocalModel("openai/gpt-oss-20b")
    const inactive = findLocalModel("Qwen/Qwen3-Coder-30B-A3B-Instruct")
    if (!active || !inactive) throw new Error("missing local models")
    mocks.listDownloadedLocalModels.mockResolvedValue([active, inactive])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: active.id,
        modelDisplayName: active.displayName,
        modelContextLength: 32_768,
        modelProvider: "local",
      }),
    )
    mocks.deleteLocalGguf.mockImplementationOnce(async () => {
      mocks.listDownloadedLocalModels.mockResolvedValue([active])
    })
    await loadCli()
    mocks.stopLocalRuntime.mockClear()

    await submit(`/delete-model ${inactive.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(inactive))

    expect(mocks.stopLocalRuntime).not.toHaveBeenCalled()
    expect(mocks.clearSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ui.showCommandSubmenu).toHaveBeenLastCalledWith([
      expect.objectContaining({
        name: active.displayName,
        description: expect.stringContaining("Active ·"),
        submission: `/delete-model ${active.id}`,
      }),
    ])
  })

  it("stops llama.cpp and clears selection before deleting the active local model", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: cached.id,
        modelDisplayName: cached.displayName,
        modelContextLength: 32_768,
        modelProvider: "local",
      }),
    )
    mocks.deleteLocalGguf.mockImplementationOnce(async () => {
      mocks.listDownloadedLocalModels.mockResolvedValue([])
    })
    await loadCli()
    mocks.stopLocalRuntime.mockClear()

    await submit(`/delete-model ${cached.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(cached))

    expect(mocks.clearSelectedModel).toHaveBeenCalledBefore(mocks.stopLocalRuntime)
    expect(mocks.stopLocalRuntime).toHaveBeenCalledBefore(mocks.deleteLocalGguf)
    expect(mocks.ui.showHomeLayout).not.toHaveBeenCalled()
    expect(mocks.ui.showSetupButton).not.toHaveBeenCalled()
    expect(mocks.ui.setModelLabel).toHaveBeenCalledWith("No model")
    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalled())
    expect(latestCommandNames()).not.toContain("/delete-model")
  })

  it("restores an active local selection when its model file cannot be deleted", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: cached.id,
        modelDisplayName: cached.displayName,
        modelContextLength: 32_768,
        modelProvider: "local",
      }),
    )
    mocks.deleteLocalGguf.mockRejectedValueOnce(new Error("model file is locked"))
    await loadCli()
    mocks.saveSelectedModel.mockClear()

    await submit(`/delete-model ${cached.id}`)
    await vi.waitFor(() => expect(mocks.ui.showTransientHint).toHaveBeenCalledWith(expect.stringContaining("locked")))

    expect(mocks.clearSelectedModel).toHaveBeenCalled()
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: cached.id, provider: "local", contextLength: 32_768 }),
    )
    expect(mocks.ensureLocalServing).toHaveBeenCalledTimes(2)
    expect(mocks.ui.showHomeLayout).not.toHaveBeenCalled()
  })

  it("leaves the saved and active model unchanged when local startup fails", async () => {
    mocks.ensureLocalServing.mockRejectedValueOnce(new Error("model failed to load"))
    await loadCli()
    await submit("/model")
    mocks.saveSelectedModel.mockClear()
    mocks.ui.hideModelPicker.mockClear()
    mocks.ui.setModelLabel.mockClear()

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const local = picker.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")
    if (!local) throw new Error("missing local picker item")
    mocks.uiOptions?.onSelectModel?.(local)
    await settle()

    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ui.hideModelPicker).not.toHaveBeenCalled()
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith("gpt-oss 20B")
    expect(mocks.ui.showSetupError).toHaveBeenCalledWith("model failed to load")
  })

  it("rolls back a prepared local runtime when saving the selection fails", async () => {
    mocks.saveSelectedModel.mockRejectedValueOnce(new Error("config is read-only"))
    await loadCli()
    await submit("/model")
    mocks.ui.hideModelPicker.mockClear()
    mocks.ui.setModelLabel.mockClear()
    mocks.stopLocalRuntime.mockClear()

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const local = picker.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")
    if (!local) throw new Error("missing local picker item")
    mocks.uiOptions?.onSelectModel?.(local)
    await settle()

    expect(mocks.ensureLocalServing).toHaveBeenCalledBefore(mocks.saveSelectedModel)
    expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
    expect(mocks.ui.hideModelPicker).not.toHaveBeenCalled()
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith("gpt-oss 20B")
    expect(mocks.ui.showSetupError).toHaveBeenCalledWith("config is read-only")
  })

  it("does not let a stale local load complete a newer selection", async () => {
    let firstSignal: AbortSignal | undefined
    let finishSecond: ((value: { model: string; inferenceURL: string; contextLength: number }) => void) | undefined
    mocks.ensureLocalServing
      .mockImplementationOnce(
        (_spec, _fit, _hardware, options) =>
          new Promise((_resolve, reject) => {
            firstSignal = options?.signal
            firstSignal?.addEventListener("abort", () => reject(firstSignal?.reason), { once: true })
          }),
      )
      .mockImplementationOnce(
        (spec) =>
          new Promise((resolve) => {
            finishSecond = resolve
            void spec
          }),
      )
    await loadCli()
    await submit("/model")
    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const first = picker.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")
    const second = picker.find((item) => "id" in item && item.id === "Qwen/Qwen3-Coder-30B-A3B-Instruct")
    if (!first || !second) throw new Error("missing local picker items")

    mocks.uiOptions?.onSelectModel?.(first)
    await vi.waitFor(() => expect(firstSignal).toBeDefined())
    mocks.uiOptions?.onSelectModel?.(second)
    await vi.waitFor(() => expect(mocks.ensureLocalServing).toHaveBeenCalledTimes(2))

    expect(firstSignal?.aborted).toBe(true)
    expect(mocks.ui.hideModelPicker).not.toHaveBeenCalled()

    finishSecond?.({
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      inferenceURL: "http://127.0.0.1:18766/v1/chat/completions",
      contextLength: 32_768,
    })
    await vi.waitFor(() => expect(mocks.ui.hideModelPicker).toHaveBeenCalledOnce())
    expect(mocks.saveSelectedModel).toHaveBeenCalledOnce()
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct" }),
    )
  })

  it("keeps /model available while a local model is downloading", async () => {
    let finish: ((value: { model: string; inferenceURL: string; contextLength: number }) => void) | undefined
    mocks.ensureLocalServing.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await loadCli()
    await submit("/model")

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const local = picker.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")
    if (!local) throw new Error("missing local picker item")
    mocks.uiOptions?.onSelectModel?.(local)
    await settle()
    expect(mocks.ui.hideModelPicker).not.toHaveBeenCalled()

    mocks.ui.showModelPicker.mockClear()
    try {
      await submit("/model")
      expect(mocks.ui.showModelPicker).toHaveBeenCalled()
    } finally {
      finish?.({
        model: "openai/gpt-oss-20b",
        inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
        contextLength: 32_768,
      })
      await settle()
    }
  })

  it("keeps local models that will not fit visible but unselectable", async () => {
    mocks.detectHardware.mockResolvedValue({
      platform: "darwin",
      arch: "arm64",
      totalMemoryBytes: 8 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
      backend: "metal",
      unifiedMemory: true,
    })
    await loadCli()
    await submit("/model")

    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    const local = picker.find((item) => "id" in item && item.id === "Qwen/Qwen3.8-27B")
    expect(local).toMatchObject({ provider: "local", available: false })
    if (!local) throw new Error("missing local picker item")
    mocks.uiOptions?.onSelectModel?.(local)
    await settle()

    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ensureLocalServing).not.toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).toHaveBeenCalledWith(expect.stringMatching(/Needs /))
  })
})

function commandNames() {
  const commands = getMocks().createChatUI.mock.calls.at(-1)?.[1]?.commands as Array<{ name: string }> | undefined
  return commands?.map((command) => command.name) ?? []
}

function latestCommandNames() {
  const commands = getMocks().ui.setCommands.mock.calls.at(-1)?.[0] as Array<{ name: string }> | undefined
  return commands?.map((command) => command.name) ?? commandNames()
}
