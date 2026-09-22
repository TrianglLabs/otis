import {
  type Application,
  isSelectionCancelled,
  NO_FAST_SERVING,
  NO_TOOL_MODELS,
  type SelectionResult,
} from "../app/application.js"
import { isAbortError } from "../app/models.js"
import { listToolCapableModels } from "../inference/client.js"
import { errorMessage } from "../inference/errors.js"
import { isLocalModelId } from "../inference/local-catalog.js"
import { discoverOmlxModels, OMLX_DEFAULT_ENDPOINT } from "../inference/omlx.js"
import { discoverPairModels, PAIR_DEFAULT_ENDPOINTS, pairEngineLabel } from "../inference/pair.js"
import {
  isSelectablePickerItem,
  listModelPickerItems,
  type ModelPickerChoice,
  type ModelPickerItem,
} from "../inference/picker-catalog.js"
import { selectDefaultFireworksModel } from "../inference/serving-path.js"
import {
  type CatalogModel,
  type FireworksModel,
  type OmlxCatalogModel,
  type PairCatalogModel,
  supportsOmlx,
} from "../inference/types.js"
import { saveFireworksSetup, saveSelectedModel } from "../local/settings.js"
import { openFireworksKeyPage } from "./provider-links.js"
import type {
  ChatUI,
  PairEndpointInputs,
  SetupInferenceChoice,
  SetupLocalInferenceChoice,
} from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  app: Application
  localInferenceUnavailableReason?: string
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  /** A model is ready to chat with. */
  onConfigured: () => void
  /** A hosted key was verified and saved. */
  onCredentialsChanged: () => void
}

type ModelPickerOpenOptions = {
  background?: boolean
  sources?: "all" | "managed"
}

/**
 * The terminal's setup screens: inference choice, hosted key, local servers, and the model picker.
 * Every transaction is the application's; this class owns which screen shows next.
 */
export class SetupFlow {
  /** A hosted key entered during onboarding, saved together with the first model it selects. */
  #candidateKey: string | undefined
  #pairModels: PairCatalogModel[] = []
  #omlxModels: OmlxCatalogModel[] = []
  #models: FireworksModel[] = []
  #credentialPurpose: "onboarding" | "settings" = "onboarding"
  #modelPickerBackTarget: "choice" | "local" = "choice"
  #wasConfigured = false
  #openedFireworksKeyPage = false
  #catalogController: AbortController | undefined
  #catalogTask: Promise<void> | undefined
  #closed = false

  constructor(private readonly options: SetupFlowOptions) {}

  get #app() {
    return this.options.app
  }

  get #fireworksApiKey() {
    return this.#candidateKey ?? this.#app.fireworksApiKey
  }

  begin() {
    if (this.#closed || this.options.isBusy()) return
    this.#credentialPurpose = "onboarding"
    const { selectedId, selectedProvider } = this.#app.models
    if (selectedProvider === "pair" || selectedProvider === "omlx") {
      this.requestPairEndpoints("Reconnect to your local server, then choose a model.")
      return
    }
    const apiKey = this.#fireworksApiKey
    if (!apiKey) {
      this.options.ui.showSetupInferenceChoice()
      return
    }
    if (!selectedId) {
      void this.selectDefaultModel(apiKey)
      return
    }
    if (selectedProvider === "local" || isLocalModelId(selectedId)) {
      void this.openModelPicker(false)
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
    // A rejected hosted key draft does not follow the user into local setup.
    this.#candidateKey = undefined
    this.#models = []
    this.#openedFireworksKeyPage = false
    this.#modelPickerBackTarget = "local"
    void this.openModelPicker(false, { sources: "managed" })
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
      this.#candidateKey = apiKey
      await this.selectDefaultModel(apiKey)
      return
    }

    await this.runCatalogOperation(async (signal) => {
      if (this.#closed || this.options.isBusy()) return
      this.options.setBusy(true)
      this.options.ui.showSetupStatus("Checking hosted inference...")
      try {
        this.#models = await this.#app.setFireworksApiKey(apiKey, { signal })
        if (this.#closed) return
        this.options.onCredentialsChanged()
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
        const connection = await this.#app.connectLocalServers(inputs, { signal })
        this.#pairModels = connection.pairModels
        this.#omlxModels = connection.omlxModels
        this.#modelPickerBackTarget = settings ? "choice" : "local"
        this.#wasConfigured = settings
        if (this.#closed) return
        const items = await this.listPickerItems(this.#fireworksApiKey, this.#pairModels, signal)
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

  async openModelPicker(wasConfigured: boolean, options: ModelPickerOpenOptions = {}) {
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
        const { pairEndpoints, models } = this.#app
        if (!managed && (pairEndpoints.ollama || pairEndpoints.lmStudio)) {
          const discovery = await discoverPairModels(pairEndpoints, { signal })
          this.#pairModels = [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])]
        }
        this.#omlxModels =
          !managed && models.omlx
            ? await discoverOmlxModels(models.omlx, { signal }).catch(() => [])
            : []
        const items = await this.listPickerItems(
          managed ? undefined : this.#fireworksApiKey,
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
    if (this.#closed || this.options.isBusy() || item.kind === "header") return
    if (!isSelectablePickerItem(item)) {
      this.options.ui.showTransientHint(
        ` ${item.availabilityLabel ?? "This model will not fit in memory"} `,
      )
      return
    }
    const result = await this.selectCatalogModel(item)
    if (this.#closed || !result.ok) {
      // A managed model's failure stays on its picker row; a hosted one is told.
      if (
        !this.#closed &&
        !result.ok &&
        !isSelectionCancelled(result) &&
        item.provider === "fireworks"
      )
        this.options.ui.showTransientHint(` Could not select model: ${result.reason} `)
      return
    }
    this.options.ui.hideModelPicker()
    if (item.provider === "omlx") this.options.ui.showTransientHint(" Connected to oMLX ")
    else if (item.provider === "pair") {
      this.options.ui.showTransientHint(
        ` Connected through NVIDIA PAIR · ${pairEngineLabel(item.engine)} `,
      )
    }
    this.finish()
  }

  async toggleFastServing(): Promise<"on" | "off" | "unavailable" | "error"> {
    const { selectedId, selectedProvider } = this.#app.models
    if (this.#closed || this.options.isBusy() || !this.#app.fireworksApiKey || !selectedId)
      return "unavailable"
    if (selectedProvider !== "fireworks") return "unavailable"
    const fast = !selectedId.includes("/routers/")
    this.options.setBusy(true)
    try {
      const result = await this.#app.setFastServing(fast, { catalog: this.#models })
      if (result.ok) return fast ? "on" : "off"
      if (isSelectionCancelled(result) || result.reason === NO_FAST_SERVING) return "unavailable"
      if (!this.#closed) {
        this.options.ui.showTransientHint(` Could not change Fast serving: ${result.reason} `)
      }
      return "error"
    } finally {
      this.options.setBusy(false)
    }
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

  async shutdown() {
    if (this.#closed) return
    this.#closed = true
    this.#catalogController?.abort()
    await this.#catalogTask
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
    const { pairEndpoints, models } = this.#app
    this.options.ui.showPairSetup(message, cancelTarget, {
      ollama: pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama,
      lmStudio: pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio,
      ...(supportsOmlx(process.platform)
        ? { omlx: models.omlx?.baseURL ?? OMLX_DEFAULT_ENDPOINT }
        : {}),
    })
  }

  private listPickerItems(
    fireworksApiKey: string | undefined,
    pairModels: readonly PairCatalogModel[],
    signal: AbortSignal,
  ) {
    const { models } = this.#app
    return listModelPickerItems({
      fireworksApiKey,
      currentModel: models.selectedId,
      currentProvider: models.selectedProvider,
      currentPairEngine: models.pairEngine,
      pairModels,
      omlxModels: this.#omlxModels,
      listFireworks: (key, options) => this.loadVerifiedModels(key, options?.signal),
      loadStatus: models.load,
      loadedLocalModel: models.activeLocal
        ? { model: models.activeLocal.spec.id, contextLength: models.activeLocal.contextLength }
        : undefined,
      signal,
    })
  }

  /** Onboarding: the first hosted model is chosen for the user and saved with the new key. */
  private async selectDefaultModel(apiKey: string) {
    await this.runCatalogOperation(async (signal) => {
      if (this.#closed || this.options.isBusy()) return
      this.options.setBusy(true)
      this.options.ui.showSetupStatus()

      try {
        const selected = selectDefaultFireworksModel(await this.loadVerifiedModels(apiKey, signal))
        if (!selected) throw new Error(NO_TOOL_MODELS)
        const result = await this.selectCatalogModel(selected, signal)
        if (!result.ok) {
          if (!isSelectionCancelled(result)) throw new Error(result.reason)
          return
        }
        if (!signal.aborted && !this.#closed) this.finish()
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
    this.#models = models
    return models
  }

  /**
   * One selection through the application. A hosted model chosen with a candidate key saves the
   * key and the model together; a verified key stays the application's from then on.
   */
  private async selectCatalogModel(
    target: ModelPickerChoice | CatalogModel,
    signal?: AbortSignal,
  ): Promise<SelectionResult> {
    if (target.provider !== "fireworks" || !this.#candidateKey)
      return this.#app.selectModel(target, { signal })
    const apiKey = this.#candidateKey
    const result = await this.#app.selectModel(target, {
      signal,
      fireworksApiKey: apiKey,
      persist: (serving) =>
        serving.provider === "fireworks"
          ? saveFireworksSetup(apiKey, serving)
          : saveSelectedModel(serving),
    })
    if (result.ok) {
      this.#candidateKey = undefined
      this.options.onCredentialsChanged()
    }
    return result
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

  private finish() {
    this.options.onConfigured()
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }
}
