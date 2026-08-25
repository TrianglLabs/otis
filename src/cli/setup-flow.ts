import { listToolCapableModels } from "../inference/client.js"
import { isLocalModelId } from "../inference/local-catalog.js"
import { selectDefaultFireworksModel } from "../inference/model-policy.js"
import {
  isSelectablePickerItem,
  listModelPickerItems,
  type ModelPickerItem,
  toLocalCatalogModel,
} from "../inference/picker-catalog.js"
import { findFireworksModel, fireworksServingModel, isFastFireworksModel } from "../inference/serving-path.js"
import type { CatalogModel, FireworksModel, LocalCatalogModel } from "../inference/types.js"
import { type LocalSettings, saveFastMode, saveFireworksSetup, saveSelectedModel } from "../local/settings.js"
import { openFireworksKeyPage } from "./provider-links.js"
import type { ChatUI } from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string }) => void
  prepareModelSelection: (
    model: CatalogModel,
    options: { signal: AbortSignal; fireworksApiKey?: string },
  ) => Promise<PreparedModelSelection>
  localLoadStatus?: () => { modelId: string; label: string } | undefined
  loadedLocalModel?: () => { model: string; contextLength: number } | undefined
  onConfigured: (fireworksApiKey: string, model: FireworksModel) => void
  fastMode: () => boolean
  onFastModeChanged: (fast: boolean) => void
}

export type PreparedModelSelection = {
  /** The exact serving model resolved during preparation, including its runtime context. */
  model: CatalogModel
  /** Commit must synchronously activate the already-prepared model and must not fail. */
  commit: () => void
  rollback: (options: { restorePrevious: boolean }) => Promise<void>
}

export class SetupFlow {
  #fireworksApiKey: string | undefined
  #selectedModel: string | undefined
  #selectedModelSupportsImageInput: boolean | undefined
  #models: FireworksModel[] = []
  #persistFireworksApiKey = false
  #wasConfigured = false
  #openedFireworksKeyPage = false
  #catalogController: AbortController | undefined
  #catalogTask: Promise<void> | undefined
  #selectionController: AbortController | undefined
  #selectionTail: Promise<void> = Promise.resolve()
  #selectionId = 0
  #closed = false

  constructor(private readonly options: SetupFlowOptions) {
    this.#fireworksApiKey = options.settings.fireworksApiKey
    this.#selectedModel = options.settings.model
    this.#selectedModelSupportsImageInput = options.settings.modelSupportsImageInput
  }

  begin() {
    if (this.#closed || this.options.isBusy()) return
    if (!this.#fireworksApiKey) {
      this.requestFireworksKey()
      return
    }
    if (!this.#selectedModel) {
      void this.selectDefaultModel(this.#fireworksApiKey)
      return
    }
    if (isLocalModelId(this.#selectedModel)) {
      void this.openModelPicker(this.#fireworksApiKey, this.#selectedModel, false)
      return
    }
    this.finish()
  }

  async submitCredential(value: string) {
    if (this.#closed) return
    const apiKey = value.trim()
    if (!apiKey) {
      this.options.ui.showSetupError("Fireworks API key is required.")
      return
    }

    this.#fireworksApiKey = apiKey
    this.#persistFireworksApiKey = true
    await this.selectDefaultModel(apiKey)
  }

  async openModelPicker(apiKey: string | undefined, currentModel: string | undefined, wasConfigured: boolean) {
    await this.runCatalogOperation((signal) => this.loadModels(apiKey, currentModel, wasConfigured, signal))
  }

  async selectModel(item: ModelPickerItem) {
    if (this.#closed || this.options.isBusy()) return
    if (item.kind === "header") return
    if (!isSelectablePickerItem(item)) {
      this.options.ui.showTransientHint(` ${item.availabilityLabel ?? "This model will not fit in memory"} `)
      return
    }
    await this.enqueueSelection(async (signal, selectionId) => {
      if (item.provider === "local") {
        await this.selectLocalModel(toLocalCatalogModel(item), signal, selectionId)
        return
      }
      await this.selectFireworksModel(item.id, signal, selectionId)
    })
  }

  async toggleFastServing() {
    if (this.#closed || this.options.isBusy() || !this.#fireworksApiKey || !this.#selectedModel) {
      return "unavailable" as const
    }
    if (isLocalModelId(this.#selectedModel)) return "unavailable" as const
    return (
      (await this.enqueueSelection(async (signal) => {
        this.options.setBusy(true)
        const previousFast = this.options.fastMode()
        try {
          const models =
            this.#models.length > 0
              ? this.#models
              : await this.loadVerifiedModels(this.#fireworksApiKey as string, signal)
          const selected = findFireworksModel(models, this.#selectedModel as string)
          if (!selected?.fastId) return "unavailable" as const

          const fast = !isFastFireworksModel(this.#selectedModel as string)
          this.options.onFastModeChanged(fast)
          await saveFastMode(fast)
          await this.persistFireworksSelection(selected, signal)
          return fast ? ("on" as const) : ("off" as const)
        } catch (error) {
          this.options.onFastModeChanged(previousFast)
          if (!signal.aborted && !this.#closed) this.options.ui.showSetupError(errorMessage(error))
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
    this.options.ui.showSetupButton()
  }

  async cancelModelSelection() {
    this.#selectionId += 1
    this.#selectionController?.abort()
    await this.#selectionTail
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
    this.#selectionController?.abort()
    await Promise.allSettled([this.#catalogTask, this.#selectionTail])
  }

  private requestFireworksKey() {
    this.options.ui.showSetupInput()
    if (this.#openedFireworksKeyPage) return
    this.#openedFireworksKeyPage = true
    void openFireworksKeyPage()
  }

  private async loadModels(
    apiKey: string | undefined,
    currentModel: string | undefined,
    wasConfigured: boolean,
    signal: AbortSignal,
  ) {
    if (this.#closed || this.options.isBusy()) return
    this.options.setBusy(true)
    if (wasConfigured) {
      this.options.ui.showChatLayout()
      this.options.ui.showTransientHint(" Loading models… ")
    } else {
      this.options.ui.showSetupStatus()
    }

    try {
      this.#wasConfigured = wasConfigured
      const items = await listModelPickerItems({
        fireworksApiKey: apiKey,
        currentModel,
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
        this.options.ui.showSetupError(errorMessage(error))
      }
    } finally {
      this.options.setBusy(false)
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
      if (!selected) throw new Error("Fireworks returned no public serverless models with tool support.")
      await this.persistFireworksSelection(selected, signal)
      if (!signal.aborted && !this.#closed) this.finish(selected)
    } catch (error) {
      if (!signal.aborted && !this.#closed && !isAbortError(error)) this.options.ui.showSetupError(errorMessage(error))
    } finally {
      this.options.setBusy(false)
    }
  }

  private async loadVerifiedModels(apiKey: string, signal?: AbortSignal) {
    const models = await listToolCapableModels(apiKey, { signal })
    if (models.length === 0) throw new Error("Fireworks returned no public serverless models with tool support.")
    this.#fireworksApiKey = apiKey
    this.#models = models
    return models
  }

  private async selectLocalModel(selected: LocalCatalogModel, signal: AbortSignal, selectionId: number) {
    try {
      await this.persistSelection(selected, signal, (serving) => saveSelectedModel(serving))
      if (selectionId !== this.#selectionId || this.#closed) return
      this.options.ui.setConfigured()
      this.options.ui.hideModelPicker()
      this.options.ui.focusInput()
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.showSetupError(errorMessage(error))
    }
  }

  private async selectFireworksModel(modelId: string, signal: AbortSignal, selectionId: number) {
    const selected = findFireworksModel(this.#models, modelId)
    if (!selected) {
      if (!signal.aborted && !this.#closed) {
        this.options.ui.showSetupError("Select a model from the verified Fireworks catalog.")
      }
      return
    }

    this.options.setBusy(true)
    try {
      await this.persistFireworksSelection(selected, signal)
      if (selectionId !== this.#selectionId || this.#closed) return
      this.options.ui.hideModelPicker()
      this.finish(selected)
    } catch (error) {
      if (signal.aborted || this.#closed || isAbortError(error)) return
      this.options.ui.hideModelPicker()
      this.options.ui.showSetupError(errorMessage(error))
    } finally {
      this.options.setBusy(false)
    }
  }

  private async persistFireworksSelection(selected: FireworksModel, signal: AbortSignal) {
    const fireworksApiKey = this.#fireworksApiKey
    if (!fireworksApiKey) throw new Error("Fireworks API key is required.")
    const serving = this.servingModel(selected)

    await this.persistSelection(serving, signal, async () => {
      if (this.#persistFireworksApiKey) await saveFireworksSetup(fireworksApiKey, serving)
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
    let prepared: PreparedModelSelection | undefined
    try {
      prepared = await this.options.prepareModelSelection(selected, {
        signal,
        fireworksApiKey: this.#fireworksApiKey,
      })
      signal.throwIfAborted()
      await persist(prepared.model)
    } catch (error) {
      if (prepared) {
        try {
          await prepared.rollback({ restorePrevious: !signal.aborted && !this.#closed })
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `${errorMessage(error)} The previous model could not be restored.`,
          )
        }
      }
      throw error
    }

    // No await is allowed between persistence and commit: they become visible
    // as one selection before another queued request can supersede it.
    prepared.commit()
    this.#selectedModel = prepared.model.id
    this.#selectedModelSupportsImageInput = prepared.model.supportsImageInput
  }

  private enqueueSelection<T>(operation: (signal: AbortSignal, selectionId: number) => Promise<T>) {
    const selectionId = ++this.#selectionId
    this.#selectionController?.abort()
    const controller = new AbortController()
    this.#selectionController = controller
    const result = this.#selectionTail.then(async () => {
      if (controller.signal.aborted || this.#closed) return undefined
      return await operation(controller.signal, selectionId)
    })
    this.#selectionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result.finally(() => {
      if (this.#selectionController === controller) this.#selectionController = undefined
    })
  }

  private async runCatalogOperation(operation: (signal: AbortSignal) => Promise<void>) {
    if (this.#closed || this.options.isBusy()) return
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
    if (!model && this.#selectedModel && isLocalModelId(this.#selectedModel)) return
    const fireworksApiKey = this.#fireworksApiKey
    const selected =
      (model ? this.servingModel(model) : undefined) ??
      (this.#selectedModel ? findFireworksModel(this.#models, this.#selectedModel) : undefined) ??
      (this.#selectedModel ? modelFromId(this.#selectedModel, this.#selectedModelSupportsImageInput) : undefined)
    if (!fireworksApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey, this.servingModel(selected))
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }

  private servingModel(model: FireworksModel) {
    return fireworksServingModel(model, this.options.fastMode())
  }
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
