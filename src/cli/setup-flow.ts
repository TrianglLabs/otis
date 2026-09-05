import type { ModelHost, PersistSelectionOptions } from "../app/models.js"
import { listToolCapableModels } from "../inference/client.js"
import { isLocalModelId } from "../inference/local-catalog.js"
import { selectDefaultFireworksModel } from "../inference/model-policy.js"
import {
  discoverPairModels,
  normalizePairEndpoints,
  PAIR_DEFAULT_ENDPOINTS,
  type PairEndpoints,
  pairEngineLabel,
  pairModelKey,
} from "../inference/pair.js"
import {
  isSelectablePickerItem,
  listModelPickerItems,
  type ModelPickerItem,
  type ModelPickerStatus,
  toLocalCatalogModel,
  toPairCatalogModel,
} from "../inference/picker-catalog.js"
import { findFireworksModel, fireworksServingModel, isFastFireworksModel } from "../inference/serving-path.js"
import type {
  CatalogModel,
  FireworksModel,
  LocalCatalogModel,
  ModelProvider,
  PairCatalogModel,
  PairEngine,
} from "../inference/types.js"
import {
  type LocalSettings,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveFireworksSetup,
  savePairEndpoints,
  saveSelectedModel,
} from "../local/settings.js"
import { openFireworksKeyPage } from "./provider-links.js"
import type { ChatUI, PairEndpointInputs, SetupInferenceChoice, SetupLocalInferenceChoice } from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  models: ModelHost
  localInferenceUnavailableReason?: string
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string }) => void
  onPairEndpointsChanged: (endpoints: PairEndpoints) => void
  persistSelection: (model: CatalogModel, options: PersistSelectionOptions) => Promise<CatalogModel>
  localLoadStatus?: () => { modelId: string; status: ModelPickerStatus } | undefined
  loadedLocalModel?: () => { model: string; contextLength: number } | undefined
  onConfigured: (fireworksApiKey?: string) => void
  fastEnabled: (modelId: string) => boolean
  onFastChanged: (modelId: string, fast: boolean) => void
}

type ModelPickerOpenOptions = {
  background?: boolean
  sources?: "all" | "managed"
}

export class SetupFlow {
  #fireworksApiKey: string | undefined
  #selectedModel: string | undefined
  #selectedModelProvider: ModelProvider | undefined
  #selectedModelSupportsImageInput: boolean | undefined
  #pairEngine: PairEngine | undefined
  #pairEndpoints: PairEndpoints
  #pairModels: PairCatalogModel[] = []
  #models: FireworksModel[] = []
  #persistFireworksApiKey = false
  #credentialPurpose: "onboarding" | "settings" = "onboarding"
  #modelPickerBackTarget: "choice" | "local" = "choice"
  #wasConfigured = false
  #openedFireworksKeyPage = false
  #catalogController: AbortController | undefined
  #catalogTask: Promise<void> | undefined
  #closed = false

  constructor(private readonly options: SetupFlowOptions) {
    this.#fireworksApiKey = options.settings.fireworksApiKey
    this.#selectedModel = options.settings.model
    this.#selectedModelProvider =
      options.settings.modelProvider ??
      (options.settings.model ? (isLocalModelId(options.settings.model) ? "local" : "fireworks") : undefined)
    this.#selectedModelSupportsImageInput = options.settings.modelSupportsImageInput
    this.#pairEngine = options.settings.pairEngine
    this.#pairEndpoints = { ...options.settings.pairEndpoints }
  }

  begin() {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "onboarding"
    if (this.#selectedModelProvider === "pair") {
      this.requestPairEndpoints("Reconnect to NVIDIA PAIR, then choose a model.")
      return
    }
    if (!this.#fireworksApiKey) {
      this.options.ui.showSetupInferenceChoice()
      return
    }
    if (!this.#selectedModel) {
      void this.selectDefaultModel(this.#fireworksApiKey)
      return
    }
    if (this.#selectedModelProvider === "local" || isLocalModelId(this.#selectedModel)) {
      void this.openModelPicker(this.#fireworksApiKey, this.#selectedModel, false)
      return
    }
    this.finish()
  }

  selectInference(choice: SetupInferenceChoice) {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "onboarding"
    if (choice === "local") {
      this.options.ui.showSetupLocalInferenceChoice()
      return
    }
    this.requestFireworksKey()
  }

  selectLocalInference(choice: SetupLocalInferenceChoice) {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "onboarding"
    if (choice === "pair") {
      this.requestPairEndpoints()
      return
    }
    if (this.options.localInferenceUnavailableReason) {
      this.options.ui.showSetupLocalInferenceChoice(this.options.localInferenceUnavailableReason)
      return
    }
    this.#fireworksApiKey = this.options.settings.fireworksApiKey
    this.#models = []
    this.#persistFireworksApiKey = false
    this.#openedFireworksKeyPage = false
    this.#modelPickerBackTarget = "local"
    void this.openModelPicker(undefined, this.#selectedModel, false, { sources: "managed" })
  }

  configureHostedInference() {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "settings"
    this.#openedFireworksKeyPage = false
    this.requestFireworksKey()
  }

  configurePairInference() {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "settings"
    this.requestPairEndpoints()
  }

  async submitCredential(value: string) {
    if (this.#closed) return
    const apiKey = value.trim()
    if (!apiKey) {
      this.options.ui.showSetupError(
        "Fireworks API key is required.",
        this.#credentialPurpose === "settings" ? "configured" : "choice",
      )
      return
    }

    if (this.#credentialPurpose === "settings") {
      await this.saveHostedCredential(apiKey)
      return
    }

    this.#fireworksApiKey = apiKey
    this.#persistFireworksApiKey = true
    await this.selectDefaultModel(apiKey)
  }

  async submitPairEndpoints(endpoints: PairEndpointInputs) {
    if (this.#closed) return
    await this.connectPair(endpoints)
  }

  async openModelPicker(
    apiKey: string | undefined,
    currentModel: string | undefined,
    wasConfigured: boolean,
    options: ModelPickerOpenOptions = {},
  ) {
    await this.runCatalogOperation(
      (signal) =>
        this.loadModels(apiKey, currentModel, wasConfigured, signal, options.background === true, options.sources),
      options.background === true,
    )
  }

  async selectModel(item: ModelPickerItem) {
    if (this.#closed || this.options.isBusy()) return
    if (item.kind === "header") return
    if (!isSelectablePickerItem(item)) {
      this.options.ui.showTransientHint(` ${item.availabilityLabel ?? "This model will not fit in memory"} `)
      return
    }
    await this.options.models.enqueueSelection(async (signal) => {
      if (this.#closed) return
      if (item.provider === "local") {
        await this.selectLocalModel(toLocalCatalogModel(item), signal)
        return
      }
      if (item.provider === "pair") {
        await this.selectPairModel(toPairCatalogModel(item), signal)
        return
      }
      await this.selectFireworksModel(item.id, signal)
    })
  }

  async toggleFastServing() {
    if (this.#closed || this.options.isBusy() || !this.#fireworksApiKey || !this.#selectedModel) {
      return "unavailable" as const
    }
    if (this.#selectedModelProvider !== "fireworks") return "unavailable" as const
    return (
      (await this.options.models.enqueueSelection(async (signal) => {
        if (this.#closed) return "unavailable" as const
        this.options.setBusy(true)
        const selectedModelId = this.#selectedModel as string
        const previousFast = this.options.fastEnabled(selectedModelId)
        try {
          const models =
            this.#models.length > 0
              ? this.#models
              : await this.loadVerifiedModels(this.#fireworksApiKey as string, signal)
          const selected = findFireworksModel(models, this.#selectedModel as string)
          if (!selected?.fastId) return "unavailable" as const

          const fast = !isFastFireworksModel(this.#selectedModel as string)
          this.options.onFastChanged(selectedModelId, fast)
          await this.persistFireworksSelection(selected, signal, fast)
          return fast ? ("on" as const) : ("off" as const)
        } catch (error) {
          this.options.onFastChanged(selectedModelId, previousFast)
          if (!signal.aborted && !this.#closed) {
            this.options.ui.showTransientHint(` Could not change Fast serving: ${errorMessage(error)} `)
          }
          return signal.aborted ? ("unavailable" as const) : ("error" as const)
        } finally {
          this.options.setBusy(false)
        }
      })) ?? "unavailable"
    )
  }

  closeModelPicker() {
    if (this.#closed) return
    if (this.#wasConfigured) {
      this.options.ui.setConfigured()
      this.options.ui.focusInput()
      return
    }
    this.options.ui.showHomeLayout()
    if (this.#modelPickerBackTarget === "local") this.options.ui.showSetupLocalInferenceChoice()
    else this.options.ui.showSetupInferenceChoice()
  }

  async cancelModelSelection() {
    this.options.models.cancelSelection()
    await this.options.models.waitForSelection()
  }

  forgetSelectedModel(modelId: string) {
    if (this.#selectedModel !== modelId) return
    this.#selectedModel = undefined
    this.#selectedModelSupportsImageInput = undefined
  }

  async shutdown() {
    if (this.#closed) return
    this.#closed = true
    this.#catalogController?.abort()
    this.options.models.cancelSelection()
    await Promise.allSettled([this.#catalogTask, this.options.models.waitForSelection()])
  }

  private requestFireworksKey() {
    this.options.ui.showSetupInput("", this.#credentialPurpose === "settings" ? "configured" : "choice")
    if (this.#openedFireworksKeyPage) return
    this.#openedFireworksKeyPage = true
    void openFireworksKeyPage()
  }

  private requestPairEndpoints(message = "") {
    const cancelTarget = this.#credentialPurpose === "settings" ? "configured" : "local"
    this.options.ui.showPairSetup(message, cancelTarget, {
      ollama: this.#pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama,
      lmStudio: this.#pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio,
    })
  }

  private async connectPair(endpoints: PairEndpointInputs) {
    await this.runCatalogOperation((signal) => this.loadPairModels(endpoints, signal))
  }

  private async loadPairModels(inputs: PairEndpointInputs, signal: AbortSignal) {
    if (this.#closed || this.options.isBusy()) return
    this.options.setBusy(true)
    this.options.ui.showSetupStatus("Checking NVIDIA PAIR endpoints…")
    const cancelTarget = this.#credentialPurpose === "settings" ? "configured" : "local"
    try {
      const requested = pairEndpointsFromInputs(inputs)
      if (!requested.ollama && !requested.lmStudio) throw new Error("Enter at least one NVIDIA PAIR endpoint.")
      const discovery = await discoverPairModels(requested, { signal })
      signal.throwIfAborted()
      if (discovery.ollama === undefined && discovery.lmStudio === undefined) {
        throw new Error(
          "NVIDIA PAIR was not found. Start PAIR, enable Ollama or LM Studio, then copy its local endpoint here.",
        )
      }
      const models = [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])]
      if (models.length === 0) {
        throw new Error("PAIR is running, but its cluster has no available models. Add a model in PAIR and try again.")
      }
      this.#pairEndpoints = {
        ...(discovery.ollama !== undefined && requested.ollama ? { ollama: requested.ollama } : {}),
        ...(discovery.lmStudio !== undefined && requested.lmStudio ? { lmStudio: requested.lmStudio } : {}),
      }
      await savePairEndpoints(this.#pairEndpoints)
      this.options.onPairEndpointsChanged({ ...this.#pairEndpoints })
      this.#pairModels = models
      this.#modelPickerBackTarget = this.#credentialPurpose === "settings" ? "choice" : "local"
      this.#wasConfigured = this.#credentialPurpose === "settings"
      if (!this.#closed) {
        const items = await listModelPickerItems({
          fireworksApiKey: this.#fireworksApiKey,
          currentModel: this.#selectedModel,
          currentProvider: this.#selectedModelProvider,
          currentPairEngine: this.#pairEngine,
          pairModels: models,
          listFireworks: (key, options) => this.loadVerifiedModels(key, options?.signal),
          loadStatus: this.options.localLoadStatus?.(),
          loadedLocalModel: this.options.loadedLocalModel?.(),
          signal,
        })
        signal.throwIfAborted()
        this.options.ui.showModelPicker(items)
      }
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.showPairSetupError(errorMessage(error), cancelTarget, inputs)
    } finally {
      this.options.setBusy(false)
    }
  }

  private async saveHostedCredential(apiKey: string) {
    await this.runCatalogOperation((signal) => this.persistHostedCredential(apiKey, signal))
  }

  private async persistHostedCredential(apiKey: string, signal: AbortSignal) {
    if (this.#closed || this.options.isBusy()) return
    this.options.setBusy(true)
    this.options.ui.showSetupStatus("Checking hosted inference...")

    try {
      const models = await listToolCapableModels(apiKey, { signal })
      signal.throwIfAborted()
      if (models.length === 0) throw new Error("The hosted provider returned no public models with tool support.")
      await saveFireworksApiKey(apiKey)

      this.#fireworksApiKey = apiKey
      this.#models = models
      if (this.#closed) return
      this.options.onCredentialsChanged({ fireworksApiKey: apiKey })
      this.options.ui.setConfigured()
      this.options.ui.showTransientHint(" Hosted inference configured ")
      this.options.ui.focusInput()
    } catch (error) {
      if (!signal.aborted && !this.#closed && !isAbortError(error)) {
        this.options.ui.showSetupError(errorMessage(error), "configured")
      }
    } finally {
      this.options.setBusy(false)
    }
  }

  private async loadModels(
    apiKey: string | undefined,
    currentModel: string | undefined,
    wasConfigured: boolean,
    signal: AbortSignal,
    background: boolean,
    sources: ModelPickerOpenOptions["sources"],
  ) {
    if (this.#closed || (!background && this.options.isBusy())) return
    if (!background) this.options.setBusy(true)
    if (wasConfigured) {
      this.options.ui.showChatLayout()
      if (!background) this.options.ui.showTransientHint(" Loading models… ")
    } else {
      this.options.ui.showSetupStatus()
    }

    try {
      this.#wasConfigured = wasConfigured
      if (sources !== "managed" && (this.#pairEndpoints.ollama || this.#pairEndpoints.lmStudio)) {
        const discovery = await discoverPairModels(this.#pairEndpoints, { signal })
        this.#pairModels = [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])]
      }
      const items = await listModelPickerItems({
        fireworksApiKey: apiKey,
        currentModel,
        currentProvider: this.#selectedModelProvider,
        currentPairEngine: this.#pairEngine,
        pairModels: optionsPairModels(this.#pairModels, sources),
        listFireworks: (key, options) => this.loadVerifiedModels(key, options?.signal),
        loadStatus: this.options.localLoadStatus?.(),
        loadedLocalModel: this.options.loadedLocalModel?.(),
        signal,
      })
      signal.throwIfAborted()
      if (!this.#closed) this.options.ui.showModelPicker(items)
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      if (wasConfigured) {
        this.options.ui.showChatLayout()
        this.options.ui.setConfigured()
        this.options.ui.focusInput()
      } else {
        this.options.ui.showSetupInferenceChoice(errorMessage(error))
      }
    } finally {
      if (!background) this.options.setBusy(false)
    }
  }

  private async selectDefaultModel(apiKey: string) {
    await this.runCatalogOperation((signal) => this.loadDefaultModel(apiKey, signal))
  }

  private async loadDefaultModel(apiKey: string, signal: AbortSignal) {
    if (this.#closed || this.options.isBusy()) return
    this.options.setBusy(true)
    this.options.ui.showSetupStatus()

    try {
      const models = await this.loadVerifiedModels(apiKey, signal)
      const selected = selectDefaultFireworksModel(models)
      if (!selected) throw new Error("The hosted provider returned no public models with tool support.")
      await this.persistFireworksSelection(selected, signal)
      if (!signal.aborted && !this.#closed) this.finish(selected)
    } catch (error) {
      if (!signal.aborted && !this.#closed && !isAbortError(error)) {
        this.options.ui.showSetupError(errorMessage(error), "choice")
      }
    } finally {
      this.options.setBusy(false)
    }
  }

  private async loadVerifiedModels(apiKey: string, signal?: AbortSignal) {
    const models = await listToolCapableModels(apiKey, { signal })
    if (models.length === 0) throw new Error("The hosted provider returned no public models with tool support.")
    this.#fireworksApiKey = apiKey
    this.#models = models
    return models
  }

  private async selectLocalModel(selected: LocalCatalogModel, signal: AbortSignal) {
    try {
      await this.persistSelection(selected, signal, (serving) => saveSelectedModel(serving))
      if (signal.aborted || this.#closed) return
      this.options.onConfigured()
      this.options.ui.setConfigured()
      this.options.ui.hideModelPicker()
      this.options.ui.focusInput()
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.setModelPickerStatus(selected.id, {
        label: `Failed: ${errorMessage(error)}`,
        kind: "error",
      })
    }
  }

  private async selectPairModel(selected: PairCatalogModel, signal: AbortSignal) {
    const key = pairModelKey(selected)
    try {
      await this.persistSelection(selected, signal, (serving) => saveSelectedModel(serving))
      if (signal.aborted || this.#closed) return
      this.options.onConfigured()
      this.options.ui.setConfigured()
      this.options.ui.hideModelPicker()
      this.options.ui.showTransientHint(` Connected through NVIDIA PAIR · ${pairEngineLabel(selected.engine)} `)
      this.options.ui.focusInput()
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.setModelPickerStatus(key, {
        label: `Failed: ${errorMessage(error)}`,
        kind: "error",
      })
    }
  }

  private async selectFireworksModel(modelId: string, signal: AbortSignal) {
    const selected = findFireworksModel(this.#models, modelId)
    if (!selected) {
      if (!signal.aborted && !this.#closed) {
        this.options.ui.showTransientHint(" Select a model from the verified hosted catalog. ")
      }
      return
    }

    this.options.setBusy(true)
    try {
      await this.persistFireworksSelection(selected, signal)
      if (signal.aborted || this.#closed) return
      this.options.ui.hideModelPicker()
      this.finish(selected)
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.showTransientHint(` Could not select model: ${errorMessage(error)} `)
    } finally {
      this.options.setBusy(false)
    }
  }

  private async persistFireworksSelection(selected: FireworksModel, signal: AbortSignal, fast?: boolean) {
    const fireworksApiKey = this.#fireworksApiKey
    if (!fireworksApiKey) throw new Error("Fireworks API key is required.")
    const serving = this.servingModel(selected)

    await this.persistSelection(serving, signal, async () => {
      if (fast !== undefined) await saveFastServingSelection(serving, fast)
      else if (this.#persistFireworksApiKey) await saveFireworksSetup(fireworksApiKey, serving)
      else await saveSelectedModel(serving)
    })
    this.#persistFireworksApiKey = false
    this.options.onCredentialsChanged({ fireworksApiKey })
  }

  private async persistSelection(
    selected: CatalogModel,
    signal: AbortSignal,
    persist: (serving: CatalogModel) => Promise<void>,
  ) {
    const model = await this.options.persistSelection(selected, {
      signal,
      persist,
      fireworksApiKey: this.#fireworksApiKey,
      isClosed: () => this.#closed,
    })
    this.#selectedModel = model.id
    this.#selectedModelProvider = model.provider
    this.#selectedModelSupportsImageInput = model.supportsImageInput
    this.#pairEngine = model.provider === "pair" ? model.engine : undefined
  }

  private async runCatalogOperation(operation: (signal: AbortSignal) => Promise<void>, allowWhileBusy = false) {
    if (this.#closed || (!allowWhileBusy && this.options.isBusy())) return
    this.#catalogController?.abort()
    const controller = new AbortController()
    this.#catalogController = controller
    const task = operation(controller.signal)
    this.#catalogTask = task
    try {
      await task
    } finally {
      if (this.#catalogController === controller) this.#catalogController = undefined
      if (this.#catalogTask === task) this.#catalogTask = undefined
    }
  }

  private finish(model?: FireworksModel) {
    if (!model && this.#selectedModelProvider !== "fireworks") return
    const fireworksApiKey = this.#fireworksApiKey
    const selected =
      (model ? this.servingModel(model) : undefined) ??
      (this.#selectedModel ? findFireworksModel(this.#models, this.#selectedModel) : undefined) ??
      (this.#selectedModel ? modelFromId(this.#selectedModel, this.#selectedModelSupportsImageInput) : undefined)
    if (!fireworksApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey)
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }

  private servingModel(model: FireworksModel) {
    return fireworksServingModel(model, this.options.fastEnabled(model.id))
  }
}

function optionsPairModels(cached: readonly PairCatalogModel[], sources: ModelPickerOpenOptions["sources"]) {
  return sources === "managed" ? [] : cached
}

function pairEndpointsFromInputs(inputs: PairEndpointInputs): PairEndpoints {
  return normalizePairEndpoints({
    ...(inputs.ollama.trim() ? { ollama: inputs.ollama } : {}),
    ...(inputs.lmStudio.trim() ? { lmStudio: inputs.lmStudio } : {}),
  })
}

function modelFromId(id: string, supportsImageInput = false): FireworksModel {
  return { provider: "fireworks", id, displayName: id.split("/").at(-1) ?? id, supportsImageInput }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
