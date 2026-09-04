import { describe, expect, it, vi } from "vitest"
import { findLocalModel } from "../../src/inference/local-catalog.js"
import {
  type LocalPickerChoice,
  type ModelPickerItem,
  toFireworksPickerChoice,
} from "../../src/inference/picker-catalog.js"
import {
  getMocks,
  loadCli,
  localSettings,
  settle,
  submit,
  testModel,
  testPairModel,
} from "./support/interactive-cli-harness.js"

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
    expect(mocks.ui.showSetupInferenceChoice).toHaveBeenCalledOnce()
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalled()
    expect(mocks.openFireworksKeyPage).not.toHaveBeenCalled()

    mocks.uiOptions?.onSetupInferenceChoice?.("hosted")
    expect(mocks.ui.showSetupInput).toHaveBeenCalledOnce()
    expect(mocks.openFireworksKeyPage).toHaveBeenCalledOnce()

    mocks.uiOptions?.onSetupSubmit?.(" ")
    expect(mocks.ui.showSetupError).toHaveBeenLastCalledWith("Fireworks API key is required.", "choice")

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

  it("opens the hardware-filtered local catalog without asking for a Fireworks key", async () => {
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
    mocks.uiOptions?.onSetupInferenceChoice?.("local")
    expect(mocks.ui.showSetupLocalInferenceChoice).toHaveBeenCalledOnce()
    mocks.uiOptions?.onSetupLocalInferenceChoice?.("managed")
    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalledOnce())

    expect(mocks.ui.showSetupStatus).toHaveBeenCalledOnce()
    expect(mocks.listToolCapableModels).not.toHaveBeenCalled()
    expect(mocks.openFireworksKeyPage).not.toHaveBeenCalled()
    expect(mocks.ui.showSetupInput).not.toHaveBeenCalled()
    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(picker[0]).toMatchObject({ kind: "header", displayName: "Local" })
    expect(picker).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "openai/gpt-oss-20b", provider: "local" })]),
    )
    expect(picker).not.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "fireworks" })]))
  })

  it("connects to PAIR, discovers cluster models, and saves the selected route", async () => {
    const lmStudioModel = testPairModel({
      id: "google/gemma-4-e4b",
      displayName: "Gemma 4 E4B",
      baseURL: "http://127.0.0.1:1234",
      engine: "lmstudio",
    })
    mocks.discoverPairModels.mockResolvedValueOnce({
      ollama: [testPairModel()],
      lmStudio: [lmStudioModel],
      errors: [],
    })
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
        modelProvider: undefined,
        pairEndpoints: {
          ollama: "http://127.0.0.1:11434",
          lmStudio: "http://127.0.0.1:1234",
        },
      }),
    )
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupInferenceChoice?.("local")
    mocks.uiOptions?.onSetupLocalInferenceChoice?.("pair")
    expect(mocks.ui.showPairSetup).toHaveBeenLastCalledWith("", "local", {
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })

    mocks.uiOptions?.onPairSetupSubmit?.({
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalledOnce())
    expect(mocks.ui.showSetupStatus).toHaveBeenCalledWith("Checking NVIDIA PAIR endpoints…")
    expect(mocks.discoverPairModels).toHaveBeenCalledWith(
      {
        ollama: "http://127.0.0.1:11434",
        lmStudio: "http://127.0.0.1:1234",
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.savePairEndpoints).toHaveBeenCalledWith({
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(picker).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "header", displayName: "NVIDIA PAIR" })]),
    )
    const pairModel = picker.find((item) => "provider" in item && item.provider === "pair")
    if (!pairModel) throw new Error("missing PAIR model")

    mocks.uiOptions?.onSelectModel?.(pairModel)
    await vi.waitFor(() => expect(mocks.saveSelectedModel).toHaveBeenCalled())

    expect(mocks.PairClient).toHaveBeenCalledWith({
      baseURL: "http://127.0.0.1:11434",
      model: "qwen3.5:35b",
    })
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "pair" }))
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("Qwen 3.5 35B · NVIDIA PAIR")
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Connected through NVIDIA PAIR · Ollama ")
  })

  it("reopens a saved PAIR model without starting Otis's managed llama.cpp runtime", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: "qwen3.5:35b",
        modelDisplayName: "Qwen 3.5 35B",
        modelContextLength: 8_192,
        modelProvider: "pair",
        pairEndpoints: { ollama: "http://127.0.0.1:11434" },
        pairEngine: "ollama",
      }),
    )

    await loadCli()

    expect(mocks.uiOptions?.configured).toBe(true)
    expect(mocks.uiOptions?.modelLabel).toBe("Qwen 3.5 35B · NVIDIA PAIR")
    expect(mocks.PairClient).toHaveBeenCalledWith({
      baseURL: "http://127.0.0.1:11434",
      model: "qwen3.5:35b",
    })
    expect(mocks.ensureLocalServing).not.toHaveBeenCalled()
    expect(mocks.stopLocalRuntime).not.toHaveBeenCalled()
  })

  it("accepts one reachable PAIR engine when the other standard proxy is unavailable", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: undefined,
        modelDisplayName: undefined,
        modelContextLength: undefined,
        modelProvider: undefined,
        pairEndpoints: {
          ollama: "http://127.0.0.1:11434",
          lmStudio: "http://127.0.0.1:1234",
        },
      }),
    )
    mocks.discoverPairModels.mockResolvedValueOnce({
      ollama: [testPairModel()],
      errors: [{ engine: "lmstudio", baseURL: "http://127.0.0.1:1234", error: new Error("offline") }],
    })
    await loadCli()

    mocks.uiOptions?.onSetup?.()
    mocks.uiOptions?.onSetupInferenceChoice?.("local")
    mocks.uiOptions?.onSetupLocalInferenceChoice?.("pair")
    mocks.uiOptions?.onPairSetupSubmit?.({
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })

    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalledOnce())
    expect(mocks.savePairEndpoints).toHaveBeenCalledWith({ ollama: "http://127.0.0.1:11434" })
    expect(mocks.ui.showPairSetupError).not.toHaveBeenCalled()
  })

  it("uses the engine field directly instead of probing to infer its type", async () => {
    const ollamaModel = testPairModel({
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama",
    })
    mocks.discoverPairModels.mockResolvedValueOnce({
      ollama: [ollamaModel],
      errors: [],
    })
    await loadCli()
    const inputs = { ollama: "http://127.0.0.1:11434", lmStudio: "" }

    await submit("/settings pair")
    mocks.uiOptions?.onPairSetupSubmit?.(inputs)

    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalled())
    expect(mocks.discoverPairModels).toHaveBeenCalledWith(
      { ollama: "http://127.0.0.1:11434" },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.savePairEndpoints).toHaveBeenCalledWith({ ollama: "http://127.0.0.1:11434" })
    expect(mocks.ui.showPairSetupError).not.toHaveBeenCalled()
  })

  it("rejects the same PAIR proxy in both engine fields before discovery", async () => {
    await loadCli()
    const inputs = {
      ollama: "http://localhost:11434",
      lmStudio: "http://localhost:11434/v1",
    }

    await submit("/settings pair")
    mocks.uiOptions?.onPairSetupSubmit?.(inputs)

    await vi.waitFor(() =>
      expect(mocks.ui.showPairSetupError).toHaveBeenCalledWith(
        "Ollama and LM Studio endpoints must be different.",
        "configured",
        inputs,
      ),
    )
    expect(mocks.discoverPairModels).not.toHaveBeenCalled()
    expect(mocks.savePairEndpoints).not.toHaveBeenCalled()
  })

  it("offers PAIR in Settings and prefills a saved endpoint", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        pairEndpoints: { lmStudio: "http://127.0.0.1:1234" },
      }),
    )
    await loadCli()

    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "NVIDIA PAIR", description: "Reconnect or choose model" }),
      ]),
    )

    await submit("/settings pair")
    expect(mocks.ui.showPairSetup).toHaveBeenLastCalledWith("", "configured", {
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
  })

  it("recovers an incomplete saved PAIR selection by asking for its endpoint", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: "qwen3.5:35b",
        modelDisplayName: "Qwen 3.5 35B",
        modelProvider: "pair",
        pairEngine: "ollama",
        pairEndpoints: { lmStudio: "http://127.0.0.1:1234" },
      }),
    )

    await loadCli()

    expect(mocks.uiOptions?.configured).toBe(false)
    expect(mocks.ui.showPairSetup).toHaveBeenCalledWith("Reconnect to NVIDIA PAIR, then choose a model.", "local", {
      ollama: "http://127.0.0.1:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
  })

  it("adds a validated hosted key from settings without replacing the active local model", async () => {
    const local = findLocalModel("openai/gpt-oss-20b")
    if (!local) throw new Error("missing local model")
    const hosted = testModel({ displayName: "Hosted Model" })
    mocks.listToolCapableModels.mockResolvedValue([hosted])
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        fireworksApiKey: undefined,
        model: local.id,
        modelDisplayName: local.displayName,
        modelContextLength: 32_768,
        modelProvider: "local",
      }),
    )
    await loadCli()
    mocks.saveSelectedModel.mockClear()

    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Hosted inference", description: "Add API key" })]),
    )

    await submit("/settings hosted")
    expect(mocks.ui.showSetupInput).toHaveBeenLastCalledWith("", "configured")
    expect(mocks.openFireworksKeyPage).toHaveBeenCalledOnce()

    mocks.uiOptions?.onSetupSubmit?.("fw_added_key")
    await vi.waitFor(() => expect(mocks.saveFireworksApiKey).toHaveBeenCalledWith("fw_added_key"))

    expect(mocks.listToolCapableModels).toHaveBeenCalledWith("fw_added_key", {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.saveSelectedModel).not.toHaveBeenCalled()
    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.ui.showTransientHint).toHaveBeenLastCalledWith(" Hosted inference configured ")

    mocks.ui.showModelPicker.mockClear()
    await submit("/model")
    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(picker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "header", displayName: "Hosted" }),
        expect.objectContaining({ id: hosted.id, provider: "fireworks" }),
      ]),
    )
  })

  it("keeps hosted key settings open when validation fails", async () => {
    mocks.listToolCapableModels.mockRejectedValue(new Error("invalid API key"))
    await loadCli()

    await submit("/settings hosted")
    mocks.uiOptions?.onSetupSubmit?.("fw_invalid")
    await vi.waitFor(() => expect(mocks.ui.showSetupError).toHaveBeenCalledWith("invalid API key", "configured"))

    expect(mocks.saveFireworksApiKey).not.toHaveBeenCalled()
  })

  it("discards a rejected hosted key draft when onboarding switches to local", async () => {
    const hosted = testModel({ displayName: "Hosted Model" })
    mocks.listToolCapableModels.mockImplementation(async (apiKey) => {
      if (apiKey === "fw_rejected") throw new Error("invalid API key")
      return [hosted]
    })
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
    mocks.uiOptions?.onSetupInferenceChoice?.("hosted")
    mocks.uiOptions?.onSetupSubmit?.("fw_rejected")
    await vi.waitFor(() => expect(mocks.ui.showSetupError).toHaveBeenCalledWith("invalid API key", "choice"))

    mocks.uiOptions?.onSetupInferenceChoice?.("local")
    mocks.uiOptions?.onSetupLocalInferenceChoice?.("managed")
    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalled())
    const localPicker = (mocks.ui.showModelPicker.mock.calls.at(-1)?.[0] ?? []) as ModelPickerItem[]
    const local = localPicker.find((item) => "provider" in item && item.provider === "local" && item.available)
    if (!local) throw new Error("missing runnable local model")
    mocks.uiOptions?.onSelectModel?.(local)
    await vi.waitFor(() => expect(mocks.ui.setConfigured).toHaveBeenCalled())

    await submit("/settings hosted")
    mocks.uiOptions?.onSetupSubmit?.("fw_valid")
    await vi.waitFor(() => expect(mocks.saveFireworksApiKey).toHaveBeenCalledWith("fw_valid"))

    mocks.ui.showModelPicker.mockClear()
    mocks.saveSelectedModel.mockClear()
    await submit("/model")
    const modelPicker = (mocks.ui.showModelPicker.mock.calls.at(-1)?.[0] ?? []) as ModelPickerItem[]
    const hostedChoice = modelPicker.find((item) => "provider" in item && item.provider === "fireworks")
    if (!hostedChoice) throw new Error("missing hosted model")
    mocks.uiOptions?.onSelectModel?.(hostedChoice)
    await settle()

    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.saveSelectedModel).toHaveBeenCalledWith(hosted)
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
    mocks.uiOptions?.onSetupInferenceChoice?.("hosted")
    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()

    expect(mocks.saveFireworksSetup).not.toHaveBeenCalled()
    expect(mocks.ui.showSetupError).toHaveBeenCalledWith(
      "The hosted provider returned no public models with tool support.",
      "choice",
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
    mocks.uiOptions?.onSetupInferenceChoice?.("hosted")
    mocks.uiOptions?.onSetupSubmit?.("fw_new_key")
    await settle()

    expect(mocks.ui.showSetupError).toHaveBeenCalledWith("Could not save Fireworks setup.", "choice")
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
    expect(mocks.uiOptions?.modelLabel).toBe("gpt-oss 20B · Local")
    expect(mocks.calculateLocalStats).toHaveBeenCalled()
    expect(mocks.ui.setConfigured).not.toHaveBeenCalled()
  })

  it("advertises /fast when the saved model has a Fast serving path", async () => {
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({
        model: "accounts/fireworks/models/kimi-k3",
        modelDisplayName: "Kimi K3",
        modelFastId: "accounts/fireworks/routers/kimi-k3-fast",
      }),
    )
    await loadCli()
    expect(commandNames()).toContain("/fast")
  })

  it("offers local model deletion from settings only when a model is downloaded", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])

    await loadCli()

    expect(commandNames()).not.toContain("/delete-model")
    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        {
          name: "Delete local model",
          description: "Choose a downloaded model",
          submission: "/settings delete-model",
        },
      ]),
      { onBack: expect.any(Function) },
    )

    await submit("/settings delete-model")
    expect(mocks.ui.showCommandSubmenu).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: cached.displayName,
          submission: `/settings delete-model ${cached.id}`,
        }),
      ],
      { onBack: expect.any(Function) },
    )

    const onBack = mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[1]?.onBack
    expect(onBack).toBeTypeOf("function")
    onBack?.()
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Hosted inference" }),
        expect.objectContaining({ name: "Delete local model" }),
        expect.objectContaining({ name: "Debug mode" }),
      ]),
    )
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

  it("keeps every verified PAIR engine in one section of the normal model picker", async () => {
    const endpoints = ["http://127.0.0.1:11434", "http://127.0.0.1:1234"]
    const ollama = testPairModel()
    const lmStudio = testPairModel({
      id: "google/gemma-4-e4b",
      displayName: "Gemma 4 E4B",
      baseURL: endpoints[1],
      engine: "lmstudio",
      nativeContextLength: undefined,
    })
    mocks.loadLocalSettings.mockResolvedValue(
      localSettings({ pairEndpoints: { ollama: endpoints[0], lmStudio: endpoints[1] } }),
    )
    mocks.discoverPairModels.mockResolvedValueOnce({
      ollama: [ollama],
      lmStudio: [lmStudio],
      errors: [],
    })
    await loadCli()

    await submit("/model")

    expect(mocks.discoverPairModels).toHaveBeenCalledWith(
      { ollama: endpoints[0], lmStudio: endpoints[1] },
      { signal: expect.any(AbortSignal) },
    )
    const picker = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(picker.filter((item) => item.kind === "header" && item.id === "header-pair")).toHaveLength(1)
    expect(picker.filter((item) => "provider" in item && item.provider === "pair")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ollama.id, baseURL: endpoints[0], engine: "ollama" }),
        expect.objectContaining({ id: lmStudio.id, baseURL: endpoints[1], engine: "lmstudio" }),
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
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ fastServingModels: [kimi.id] }))
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
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ fastServingModels: [] }))
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
    expect(mocks.ui.setModelPickerStatus).toHaveBeenCalledWith("openai/gpt-oss-20b", {
      label: "Downloading 47%",
      kind: "progress",
    })
    expect(mocks.ui.setModelPickerStatus).toHaveBeenCalledWith("openai/gpt-oss-20b", {
      label: "Loading",
      kind: "progress",
    })
    expect(mocks.ui.setModelLabel).toHaveBeenLastCalledWith("gpt-oss 20B · Local")
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith(expect.stringMatching(/%|loading/i))
    expect(mocks.ui.hideModelPicker).toHaveBeenCalled()
    expect(mocks.ui.setConfigured).toHaveBeenCalled()
    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "Delete local model" })]),
      { onBack: expect.any(Function) },
    )

    mocks.ui.showModelPicker.mockClear()
    await submit("/model")
    const reopened = (mocks.ui.showModelPicker.mock.calls[0]?.[0] ?? []) as ModelPickerItem[]
    expect(reopened.find((item) => "id" in item && item.id === "openai/gpt-oss-20b")).toMatchObject({
      active: true,
      contextLength: 32_768,
      loadedContextLength: 32_768,
      availabilityLabel: expect.stringMatching(/^32K · /),
    })
    expect(
      reopened
        .filter(
          (item): item is LocalPickerChoice =>
            item.kind === "model" && item.provider === "local" && item.id !== "openai/gpt-oss-20b",
        )
        .every((item) => item.availabilityLabel.startsWith("Est. ")),
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
    await submit(`/settings delete-model ${cached.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(cached))

    expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
    expect(mocks.clearSelectedModel).not.toHaveBeenCalled()
    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Delete local model" })]),
    )
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

    await submit(`/settings delete-model ${inactive.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(inactive))

    expect(mocks.stopLocalRuntime).not.toHaveBeenCalled()
    expect(mocks.clearSelectedModel).not.toHaveBeenCalled()
    expect(mocks.ui.showCommandSubmenu).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          name: active.displayName,
          description: expect.stringContaining("Active ·"),
          submission: `/settings delete-model ${active.id}`,
        }),
      ],
      { onBack: expect.any(Function) },
    )
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

    await submit(`/settings delete-model ${cached.id}`)
    await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalledWith(cached))

    expect(mocks.clearSelectedModel).toHaveBeenCalledBefore(mocks.stopLocalRuntime)
    expect(mocks.stopLocalRuntime).toHaveBeenCalledBefore(mocks.deleteLocalGguf)
    expect(mocks.ui.showHomeLayout).not.toHaveBeenCalled()
    expect(mocks.ui.setModelLabel).toHaveBeenCalledWith("No model")
    await vi.waitFor(() => expect(mocks.ui.showModelPicker).toHaveBeenCalled())
    await submit("/settings")
    expect(mocks.ui.showCommandSubmenu.mock.calls.at(-1)?.[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Delete local model" })]),
    )
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

    await submit(`/settings delete-model ${cached.id}`)
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
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith("gpt-oss 20B · Local")
    expect(mocks.ui.setModelPickerStatus).toHaveBeenLastCalledWith(local.id, {
      label: "Failed: model failed to load",
      kind: "error",
    })
    expect(mocks.ui.showSetupError).not.toHaveBeenCalled()
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
    expect(mocks.ui.setModelLabel).not.toHaveBeenCalledWith("gpt-oss 20B · Local")
    expect(mocks.ui.setModelPickerStatus).toHaveBeenLastCalledWith(local.id, {
      label: "Failed: config is read-only",
      kind: "error",
    })
    expect(mocks.ui.showSetupError).not.toHaveBeenCalled()
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

  it("hides local models that will not fit", async () => {
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
    expect(picker.some((item) => "id" in item && item.id === "Qwen/Qwen3.8-27B")).toBe(false)
    expect(picker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "LiquidAI/LFM2.5-2.6B", provider: "local", available: true }),
      ]),
    )
  })
})

function commandNames() {
  const commands = getMocks().createChatUI.mock.calls.at(-1)?.[1]?.commands as Array<{ name: string }> | undefined
  return commands?.map((command) => command.name) ?? []
}
