import type { LocalServerConnection, LocalServerInputs } from "../app/local-servers.js"
import type { ModelHost, PersistSelectionOptions } from "../app/models.js"
import { listToolCapableModels } from "../inference/client.js"
import { isLocalModelId } from "../inference/local-catalog.js"
import { discoverOmlxModels, OMLX_DEFAULT_ENDPOINT } from "../inference/omlx.js"
import {
  discoverPairModels,
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
  toOmlxCatalogModel,
  toPairCatalogModel,
} from "../inference/picker-catalog.js"
import {
  findFireworksModel,
  fireworksServingModel,
  isFastFireworksModel,
  selectDefaultFireworksModel,
} from "../inference/serving-path.js"
import {
  type CatalogModel,
  type FireworksModel,
  type LocalCatalogModel,
  type ModelProvider,
  type OmlxCatalogModel,
  type PairCatalogModel,
  type PairEngine,
  supportsOmlx,
} from "../inference/types.js"
import {
  type LocalSettings,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveFireworksSetup,
  saveSelectedModel,
} from "../local/settings.js"
import { openFireworksKeyPage } from "./provider-links.js"
import type {
  ChatUI,
  PairEndpointInputs,
  SetupInferenceChoice,
  SetupLocalInferenceChoice,
} from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  models: ModelHost
  localInferenceUnavailableReason?: string
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string }) => void
  connectLocalServers: (
    inputs: LocalServerInputs,
    signal: AbortSignal,
  ) => Promise<LocalServerConnection>
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

const NO_TOOL_MODELS = "The hosted provider returned no public models with tool support."

export class SetupFlow {
  #fireworksApiKey: string | undefined
  #selectedModel: string | undefined
  #selectedModelProvider: ModelProvider | undefined
  #selectedModelSupportsImageInput: boolean | undefined
  #pairEngine: PairEngine | undefined
  #pairEndpoints: PairEndpoints
  #pairModels: PairCatalogModel[] = []
  #omlxModels: OmlxCatalogModel[] = []
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
      (options.settings.model
        ? isLocalModelId(options.settings.model)
          ? "local"
          : "fireworks"
        : undefined)
    this.#selectedModelSupportsImageInput = options.settings.modelSupportsImageInput
    this.#pairEngine = options.settings.pairEngine
    this.#pairEndpoints = { ...options.settings.pairEndpoints }
  }

  begin() {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "onboarding"
    if (this.#selectedModelProvider === "pair" || this.#selectedModelProvider === "omlx") {
      this.requestPairEndpoints("Reconnect to your local server, then choose a model.")
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
    if (choice === "local") this.options.ui.showSetupLocalInferenceChoice()
    else this.requestFireworksKey()
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

    if (this.#credentialPurpose !== "settings") {
      this.#fireworksApiKey = apiKey
      this.#persistFireworksApiKey = true
      await this.selectDefaultModel(apiKey)
      return
    }

    await this.runCatalogOperation(async (signal) => {
      if (this.#closed || this.options.isBusy()) return
      this.options.setBusy(true)
      this.options.ui.showSetupStatus("Checking hosted inference...")
      try {
        const models = await listToolCapableModels(apiKey, { signal })
        signal.throwIfAborted()
        if (models.length === 0) throw new Error(NO_TOOL_MODELS)
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
    })
  }

  async submitPairEndpoints(inputs: PairEndpointInputs) {
    if (this.#closed) return
    await this.runCatalogOperation(async (signal) => {
      if (this.#closed || this.options.isBusy()) return
      this.options.setBusy(true)
      this.options.ui.showSetupStatus("Checking local model server endpoints…")
      const settings = this.#credentialPurpose === "settings"
      try {
        const connection = await this.options.connectLocalServers(inputs, signal)
        this.#pairEndpoints = connection.pairEndpoints
        this.#pairModels = connection.pairModels
        this.#omlxModels = connection.omlxModels
        this.#modelPickerBackTarget = settings ? "choice" : "local"
        this.#wasConfigured = settings
        if (this.#closed) return
        const items = await this.listPickerItems(
          this.#fireworksApiKey,
          this.#selectedModel,
          this.#pairModels,
          signal,
        )
        signal.throwIfAborted()
        this.options.ui.showModelPicker(items)
      } catch (error) {
        if (signal.aborted || this.#closed || isAbortError(error)) return
        this.options.ui.showPairSetupError(
          errorMessage(error),
          settings ? "configured" : "local",
          inputs,
        )
      } finally {
        this.options.setBusy(false)
      }
    })
  }

  async openModelPicker(
    apiKey: string | undefined,
    currentModel: string | undefined,
    wasConfigured: boolean,
    options: ModelPickerOpenOptions = {},
  ) {
    const background = options.background === true
    const managed = options.sources === "managed"
    await this.runCatalogOperation(async (signal) => {
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
        if (!managed && (this.#pairEndpoints.ollama || this.#pairEndpoints.lmStudio)) {
          const discovery = await discoverPairModels(this.#pairEndpoints, { signal })
          this.#pairModels = [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])]
        }
        this.#omlxModels =
          !managed && this.options.models.omlx
            ? await discoverOmlxModels(this.options.models.omlx, { signal }).catch(() => [])
            : []
        const items = await this.listPickerItems(
          apiKey,
          currentModel,
          managed ? [] : this.#pairModels,
          signal,
        )
        signal.throwIfAborted()
        if (!this.#closed) this.options.ui.showModelPicker(items)
      } catch (error) {
        if (signal.aborted || this.#closed || isAbortError(error)) return
        if (!wasConfigured) {
          this.options.ui.showSetupInferenceChoice(errorMessage(error))
          return
        }
        this.options.ui.showChatLayout()
        this.options.ui.setConfigured()
        this.options.ui.focusInput()
      } finally {
        if (!background) this.options.setBusy(false)
      }
    }, background)
  }

  async selectModel(item: ModelPickerItem) {
    if (this.#closed || this.options.isBusy()) return
    if (item.kind === "header") return
    if (!isSelectablePickerItem(item)) {
      this.options.ui.showTransientHint(
        ` ${item.availabilityLabel ?? "This model will not fit in memory"} `,
      )
      return
    }
    await this.options.models.enqueueSelection(async (signal) => {
      if (this.#closed) return
      if (item.provider === "fireworks") {
        await this.selectFireworksModel(item.id, signal)
        return
      }
      await this.selectManagedModel(
        item.provider === "local"
          ? toLocalCatalogModel(item)
          : item.provider === "omlx"
            ? toOmlxCatalogModel(item)
            : toPairCatalogModel(item),
        signal,
      )
    })
  }

  async toggleFastServing(): Promise<"on" | "off" | "unavailable" | "error"> {
    if (this.#closed || this.options.isBusy() || !this.#fireworksApiKey || !this.#selectedModel)
      return "unavailable"
    if (this.#selectedModelProvider !== "fireworks") return "unavailable"
    return (
      (await this.options.models.enqueueSelection(
        async (signal): Promise<"on" | "off" | "unavailable" | "error"> => {
          const apiKey = this.#fireworksApiKey
          const selectedModelId = this.#selectedModel
          if (this.#closed || !apiKey || !selectedModelId) return "unavailable"
          this.options.setBusy(true)
          const previousFast = this.options.fastEnabled(selectedModelId)
          try {
            const models =
              this.#models.length > 0 ? this.#models : await this.loadVerifiedModels(apiKey, signal)
            const selected = findFireworksModel(models, selectedModelId)
            if (!selected?.fastId) return "unavailable"

            const fast = !isFastFireworksModel(selectedModelId)
            this.options.onFastChanged(selectedModelId, fast)
            await this.persistFireworksSelection(selected, signal, fast)
            return fast ? "on" : "off"
          } catch (error) {
            this.options.onFastChanged(selectedModelId, previousFast)
            if (!signal.aborted && !this.#closed) {
              this.options.ui.showTransientHint(
                ` Could not change Fast serving: ${errorMessage(error)} `,
              )
            }
            return signal.aborted ? "unavailable" : "error"
          } finally {
            this.options.setBusy(false)
          }
        },
      )) ?? "unavailable"
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
    this.options.ui.showSetupInput(
      "",
      this.#credentialPurpose === "settings" ? "configured" : "choice",
    )
    if (this.#openedFireworksKeyPage) return
    this.#openedFireworksKeyPage = true
    void openFireworksKeyPage()
  }

  private requestPairEndpoints(message = "") {
    const cancelTarget = this.#credentialPurpose === "settings" ? "configured" : "local"
    this.options.ui.showPairSetup(message, cancelTarget, {
      ollama: this.#pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama,
      lmStudio: this.#pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio,
      ...(supportsOmlx(process.platform)
        ? { omlx: this.options.models.omlx?.baseURL ?? OMLX_DEFAULT_ENDPOINT }
        : {}),
    })
  }

  private listPickerItems(
    fireworksApiKey: string | undefined,
    currentModel: string | undefined,
    pairModels: readonly PairCatalogModel[],
    signal: AbortSignal,
  ) {
    return listModelPickerItems({
      fireworksApiKey,
      currentModel,
      currentProvider: this.#selectedModelProvider,
      currentPairEngine: this.#pairEngine,
      pairModels,
      omlxModels: this.#omlxModels,
      listFireworks: (key, options) => this.loadVerifiedModels(key, options?.signal),
      loadStatus: this.options.localLoadStatus?.(),
      loadedLocalModel: this.options.loadedLocalModel?.(),
      signal,
    })
  }

  private async selectDefaultModel(apiKey: string) {
    await this.runCatalogOperation(async (signal) => {
      if (this.#closed || this.options.isBusy()) return
      this.options.setBusy(true)
      this.options.ui.showSetupStatus()

      try {
        const selected = selectDefaultFireworksModel(await this.loadVerifiedModels(apiKey, signal))
        if (!selected) throw new Error(NO_TOOL_MODELS)
        await this.persistFireworksSelection(selected, signal)
        if (!signal.aborted && !this.#closed) this.finish(selected)
      } catch (error) {
        if (!signal.aborted && !this.#closed && !isAbortError(error)) {
          this.options.ui.showSetupError(errorMessage(error), "choice")
        }
      } finally {
        this.options.setBusy(false)
      }
    })
  }

  private async loadVerifiedModels(apiKey: string, signal?: AbortSignal) {
    const models = await listToolCapableModels(apiKey, { signal })
    if (models.length === 0) throw new Error(NO_TOOL_MODELS)
    this.#fireworksApiKey = apiKey
    this.#models = models
    return models
  }

  private async selectManagedModel(
    selected: LocalCatalogModel | PairCatalogModel | OmlxCatalogModel,
    signal: AbortSignal,
  ) {
    try {
      await this.persistSelection(selected, signal, (serving) => saveSelectedModel(serving))
      if (signal.aborted || this.#closed) return
      this.options.onConfigured()
      this.options.ui.setConfigured()
      this.options.ui.hideModelPicker()
      if (selected.provider === "omlx") this.options.ui.showTransientHint(" Connected to oMLX ")
      else if (selected.provider === "pair") {
        this.options.ui.showTransientHint(
          ` Connected through NVIDIA PAIR · ${pairEngineLabel(selected.engine)} `,
        )
      }
      this.options.ui.focusInput()
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      const key =
        selected.provider === "omlx"
          ? `omlx:${selected.id}`
          : selected.provider === "pair"
            ? pairModelKey(selected)
            : selected.id
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

  private async persistFireworksSelection(
    selected: FireworksModel,
    signal: AbortSignal,
    fast?: boolean,
  ) {
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

  private async runCatalogOperation(
    operation: (signal: AbortSignal) => Promise<void>,
    allowWhileBusy = false,
  ) {
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
    const id = this.#selectedModel
    const selected =
      (model ? this.servingModel(model) : undefined) ??
      (id ? findFireworksModel(this.#models, id) : undefined) ??
      (id
        ? {
            provider: "fireworks",
            id,
            displayName: id.split("/").at(-1) ?? id,
            supportsImageInput: this.#selectedModelSupportsImageInput ?? false,
          }
        : undefined)
    if (!fireworksApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey)
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }

  private servingModel(model: FireworksModel) {
    return fireworksServingModel(model, this.options.fastEnabled(model.id))
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
