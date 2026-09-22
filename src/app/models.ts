import { autoCompactThreshold } from "../core/compaction.js"
import { FireworksClient, listToolCapableModels } from "../inference/client.js"
import { compactionContextLength, requireLocalContextLength } from "../inference/context-policy.js"
import { detectHardware, type HardwareProbe } from "../inference/hardware.js"
import { LlamaCppRuntime, type LocalLoadProgress } from "../inference/llama-runtime.js"
import {
  catalogModelFromSpec,
  findLocalModel,
  isLocalModelId,
  type LocalModelSpec,
} from "../inference/local-catalog.js"
import { LlamaCppClient } from "../inference/local-client.js"
import { fitLocalModel, type LocalModelFit } from "../inference/local-fit.js"
import {
  type LocalThinkingPreferences,
  type LocalThinkingState,
  localThinkingCapability,
} from "../inference/local-thinking.js"
import { discoverOmlxModels, OmlxClient, type OmlxSettings } from "../inference/omlx.js"
import { createPairClient, pairEndpointForEngine } from "../inference/pair.js"
import {
  findFireworksModel,
  fireworksServingModel,
  useFastServingPath,
} from "../inference/serving-path.js"
import type {
  CatalogModel,
  InferenceClient,
  ModelProvider,
  PairEngine,
} from "../inference/types.js"
import { isLocalCatalogModel, isPairCatalogModel } from "../inference/types.js"
import type { LocalSettings } from "../local/settings.js"

type ActiveLocalModel = {
  spec: LocalModelSpec
  fit: LocalModelFit
  hardware: HardwareProbe
  contextLength: number
}

type PreparedModelSelection = {
  /** The exact serving model resolved during preparation, including its runtime context. */
  model: CatalogModel
  /** Commit must synchronously activate the already-prepared model and must not fail. */
  commit: () => void
  rollback: (options: { restorePrevious: boolean }) => Promise<void>
}

type ConnectModelOptions = {
  provider: ModelProvider
  modelId: string
  fireworksApiKey?: string
  pairEndpoint?: string
  pairEngine?: PairEngine
  contextLength?: number
  supportsImageInput?: boolean
  signal?: AbortSignal
}

type ConnectedModel = {
  client: InferenceClient
  modelId: string
  provider: ModelProvider
  contextLength?: number
  supportsImageInput?: boolean
}

type PrepareModelOptions = {
  fireworksApiKey?: string
  signal: AbortSignal
  isExiting?: () => boolean
  onLocalProgress?: (progress: LocalLoadProgress) => void
}

export type PersistSelectionOptions = PrepareModelOptions & {
  persist: (serving: CatalogModel) => Promise<void>
  isClosed?: () => boolean
  wrap?: (prepared: PreparedModelSelection) => PreparedModelSelection
}

type ModelHostOptions = {
  llama?: LlamaCppRuntime
  env?: NodeJS.ProcessEnv
}

export class ModelHost {
  readonly llama: LlamaCppRuntime
  omlx: OmlxSettings | undefined
  client: InferenceClient | undefined
  selectedId: string | undefined
  selectedProvider: ModelProvider | undefined
  pairEngine: PairEngine | undefined
  supportsImageInput: boolean | undefined
  autoCompactAtTokens = autoCompactThreshold()
  activeLocal: ActiveLocalModel | undefined
  localThinking: LocalThinkingPreferences = {}
  #prepareId = 0
  #selectionId = 0
  #selectionController: AbortController | undefined
  #selectionTail: Promise<void> = Promise.resolve()

  constructor(options: ModelHostOptions = {}) {
    this.llama = options.llama ?? new LlamaCppRuntime({ env: options.env })
  }

  applySavedSelection(settings: LocalSettings) {
    this.omlx = settings.omlx
    this.localThinking = { ...settings.localThinking }
    this.selectedId = settings.model
    this.selectedProvider =
      settings.modelProvider ??
      (settings.model ? (isLocalModelId(settings.model) ? "local" : "fireworks") : undefined)
    this.pairEngine = settings.pairEngine
    this.supportsImageInput = settings.modelSupportsImageInput
    this.autoCompactAtTokens = autoCompactThreshold(
      compactionContextLength({
        provider: this.selectedProvider,
        contextLength: settings.modelContextLength,
      }),
    )

    if (settings.fireworksApiKey && this.selectedId && this.selectedProvider === "fireworks") {
      this.client = new FireworksClient({
        apiKey: settings.fireworksApiKey,
        model: this.selectedId,
      })
    }
    const pairEndpoint = pairEndpointForEngine(settings.pairEndpoints ?? {}, this.pairEngine)
    if (pairEndpoint && this.pairEngine && this.selectedId && this.selectedProvider === "pair") {
      this.client = createPairClient({
        baseURL: pairEndpoint,
        model: this.selectedId,
        engine: this.pairEngine,
      })
    }
  }

  cancelPrepare() {
    this.#prepareId += 1
  }

  thinkingState(): LocalThinkingState | null {
    if (this.selectedProvider !== "local" || !this.selectedId) return null
    const capability = localThinkingCapability(this.selectedId)
    if (!capability) return null
    return {
      ...capability,
      modelId: this.selectedId,
      selected: this.localThinking[this.selectedId] ?? "default",
    }
  }

  #localClient(model: string, inferenceURL: string) {
    return new LlamaCppClient({
      model,
      inferenceURL,
      thinkingLevel: () => this.localThinking[model],
    })
  }

  cancelSelection() {
    this.#selectionId += 1
    this.#selectionController?.abort()
  }

  async waitForSelection() {
    await this.#selectionTail
  }

  enqueueSelection<T>(
    operation: (signal: AbortSignal, selectionId: number) => Promise<T>,
  ): Promise<T | undefined> {
    const selectionId = ++this.#selectionId
    this.#selectionController?.abort()
    const controller = new AbortController()
    this.#selectionController = controller
    const result = this.#selectionTail.then(async () => {
      if (controller.signal.aborted) return undefined
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

  async persistSelection(
    selected: CatalogModel,
    options: PersistSelectionOptions,
  ): Promise<CatalogModel> {
    let prepared: PreparedModelSelection | undefined
    try {
      prepared = await this.prepare(selected, options)
      if (options.wrap) prepared = options.wrap(prepared)
      options.signal.throwIfAborted()
      await options.persist(prepared.model)
    } catch (error) {
      if (prepared) {
        try {
          await prepared.rollback({
            restorePrevious: !options.signal.aborted && options.isClosed?.() !== true,
          })
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
    return prepared.model
  }

  activate(model: CatalogModel, client: InferenceClient) {
    this.selectedId = model.id
    this.selectedProvider = model.provider
    this.pairEngine = model.provider === "pair" ? model.engine : undefined
    this.supportsImageInput = model.supportsImageInput
    this.autoCompactAtTokens = autoCompactThreshold(compactionContextLength(model))
    this.client = client
    if (model.provider !== "local") this.activeLocal = undefined
  }

  async prepare(
    model: CatalogModel,
    options: PrepareModelOptions,
  ): Promise<PreparedModelSelection> {
    const prepareId = ++this.#prepareId
    const previousLocal = this.activeLocal
    const exiting = () => options.isExiting?.() === true
    // A failed or aborted step restores whatever was serving before, unless the app is going away
    // anyway.
    const guarded = async <T>(step: () => Promise<T>) => {
      try {
        const value = await step()
        options.signal.throwIfAborted()
        return value
      } catch (error) {
        if (!options.signal.aborted && !exiting())
          await this.restorePrevious(previousLocal, error, options.signal)
        throw error
      }
    }
    const selection = (model: CatalogModel, commit: () => void): PreparedModelSelection => {
      let finalized = false
      return {
        model,
        commit: () => {
          if (finalized) return
          finalized = true
          commit()
        },
        rollback: async ({ restorePrevious }) => {
          if (finalized) return
          finalized = true
          if (restorePrevious) await this.restorePrevious(previousLocal, undefined, options.signal)
        },
      }
    }

    if (isLocalCatalogModel(model)) {
      const spec = findLocalModel(model.id)
      if (!spec) throw new Error(`Unknown local model: ${model.id}`)
      const hardware = await detectHardware()
      options.signal.throwIfAborted()
      const fit = fitLocalModel(spec, hardware)
      const selectedSpec = fit.model
      const serving = await guarded(() =>
        this.llama.ensureServing(selectedSpec, fit, hardware, {
          signal: options.signal,
          onProgress: (progress) => {
            if (prepareId !== this.#prepareId || options.signal.aborted || exiting()) return
            options.onLocalProgress?.(progress)
          },
        }),
      )
      const activeModel = { ...model, contextLength: serving.contextLength }
      return selection(activeModel, () => {
        this.activeLocal = {
          spec: selectedSpec,
          fit,
          hardware,
          contextLength: serving.contextLength,
        }
        this.activate(activeModel, this.#localClient(selectedSpec.id, serving.inferenceURL))
      })
    }

    let client: InferenceClient
    if (model.provider === "omlx") {
      requireLocalContextLength(model.contextLength, "oMLX")
      client = this.omlxClient(model.id, model.baseURL)
    } else if (isPairCatalogModel(model)) {
      client = createPairClient({ baseURL: model.baseURL, model: model.id, engine: model.engine })
    } else {
      if (!options.fireworksApiKey) throw new Error("Fireworks API key is required.")
      client = new FireworksClient({ apiKey: options.fireworksApiKey, model: model.id })
    }
    await guarded(() => this.llama.stop())
    return selection(model, () => this.activate(model, client))
  }

  async restorePrevious(
    previous: ActiveLocalModel | undefined,
    originalError?: unknown,
    signal?: AbortSignal,
  ) {
    try {
      if (!previous) {
        await this.llama.stop()
        return
      }
      const serving = await this.llama.ensureServing(
        previous.spec,
        previous.fit,
        previous.hardware,
        { signal },
      )
      signal?.throwIfAborted()
      previous.contextLength = serving.contextLength
      this.activeLocal = previous
      this.client = this.#localClient(previous.spec.id, serving.inferenceURL)
      this.selectedProvider = "local"
      if (this.selectedId === previous.spec.id) {
        this.autoCompactAtTokens = autoCompactThreshold(serving.contextLength)
      }
    } catch (restoreError) {
      if (originalError === undefined) throw restoreError
      throw new AggregateError(
        [originalError, restoreError],
        `${errorMessage(originalError)} The previous local model could not be restored.`,
      )
    }
  }

  async connect(options: ConnectModelOptions): Promise<ConnectedModel> {
    const { provider, modelId } = options
    if (provider === "local") {
      const spec = findLocalModel(modelId)
      if (!spec) throw new Error(`Unknown local model: ${modelId}`)
      const hardware = await detectHardware()
      const fit = fitLocalModel(spec, hardware)
      const selectedSpec = fit.model
      const serving = await this.llama.ensureServing(selectedSpec, fit, hardware, {
        signal: options.signal,
      })
      const client = this.#localClient(selectedSpec.id, serving.inferenceURL)
      this.activeLocal = { spec: selectedSpec, fit, hardware, contextLength: serving.contextLength }
      this.activate(catalogModelFromSpec(selectedSpec, serving.contextLength), client)
      return {
        client,
        modelId: selectedSpec.id,
        provider,
        contextLength: serving.contextLength,
        supportsImageInput: selectedSpec.supportsImageInput,
      }
    }
    if (provider === "omlx") {
      if (!this.omlx) throw new Error("oMLX is not configured. Connect it in Local servers.")
      const models = await discoverOmlxModels(this.omlx, { signal: options.signal })
      const model = models.find((entry) => entry.id === modelId)
      if (!model) throw new Error(`oMLX model is no longer available: ${modelId}`)
      requireLocalContextLength(model.contextLength, "oMLX")
      const client = this.omlxClient(model.id, model.baseURL)
      await this.llama.stop()
      options.signal?.throwIfAborted()
      this.activate(model, client)
      return {
        client,
        modelId: model.id,
        provider,
        contextLength: compactionContextLength(model),
        supportsImageInput: model.supportsImageInput,
      }
    }
    const supportsImageInput = options.supportsImageInput ?? false
    let client: InferenceClient
    let contextLength: number | undefined
    if (provider === "pair") {
      const baseURL = options.pairEndpoint
      if (!baseURL)
        throw new Error("Local model server endpoint is not configured for the selected engine.")
      const engine = options.pairEngine ?? "ollama"
      client = createPairClient({ baseURL, model: modelId, engine })
      contextLength = compactionContextLength({ provider })
      await this.llama.stop()
      this.activate(
        { provider, id: modelId, displayName: modelId, baseURL, engine, supportsImageInput },
        client,
      )
    } else {
      if (!options.fireworksApiKey) throw new Error("Fireworks API key is not configured.")
      client = new FireworksClient({ apiKey: options.fireworksApiKey, model: modelId })
      contextLength = options.contextLength
      await this.llama.stop()
      this.activate(
        { provider, id: modelId, displayName: modelId, contextLength, supportsImageInput },
        client,
      )
    }
    return {
      client,
      modelId,
      provider,
      contextLength,
      supportsImageInput: options.supportsImageInput,
    }
  }

  async stop() {
    await this.llama.stop()
  }

  omlxClient(model: string, baseURL: string) {
    if (!this.omlx || this.omlx.baseURL !== baseURL)
      throw new Error("oMLX endpoint changed. Refresh the model list.")
    return new OmlxClient({ ...this.omlx, model })
  }
}

export async function resolveFireworksServing(
  apiKey: string,
  modelId: string,
  options: { fast?: boolean; signal: AbortSignal },
) {
  const models = await listToolCapableModels(apiKey, { signal: options.signal })
  const selected = findFireworksModel(models, modelId)
  if (!selected)
    throw new Error(`Model is not a tool-capable Fireworks serverless model: ${modelId}`)
  return {
    selected,
    serving: fireworksServingModel(selected, useFastServingPath(modelId, options.fast)),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
