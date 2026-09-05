import { autoCompactThreshold } from "../core/compaction.js"
import { FireworksClient, listToolCapableModels } from "../inference/client.js"
import { compactionContextLength } from "../inference/context-policy.js"
import { detectHardware, type HardwareProbe } from "../inference/hardware.js"
import { LlamaCppRuntime, type LocalLoadProgress, type LocalServingEndpoint } from "../inference/llama-runtime.js"
import {
  catalogModelFromSpec,
  findLocalModel,
  isLocalModelId,
  type LocalModelSpec,
} from "../inference/local-catalog.js"
import { LlamaCppClient } from "../inference/local-client.js"
import { fitLocalModel, type LocalModelFit } from "../inference/local-fit.js"
import { PairClient, pairEndpointForEngine } from "../inference/pair.js"
import { findFireworksModel, fireworksServingModel, useFastServingPath } from "../inference/serving-path.js"
import type { CatalogModel, InferenceClient, ModelProvider, PairEngine } from "../inference/types.js"
import { isLocalCatalogModel, isPairCatalogModel } from "../inference/types.js"
import type { LocalSettings } from "../local/settings.js"

export type ActiveLocalModel = {
  spec: LocalModelSpec
  fit: LocalModelFit
  hardware: HardwareProbe
  contextLength: number
}

export type PreparedModelSelection = {
  /** The exact serving model resolved during preparation, including its runtime context. */
  model: CatalogModel
  /** Commit must synchronously activate the already-prepared model and must not fail. */
  commit: () => void
  rollback: (options: { restorePrevious: boolean }) => Promise<void>
}

export type ConnectModelOptions = {
  provider: ModelProvider
  modelId: string
  fireworksApiKey?: string
  pairEndpoint?: string
  pairEngine?: PairEngine
  contextLength?: number
  supportsImageInput?: boolean
  signal?: AbortSignal
}

export type ConnectedModel = {
  client: InferenceClient
  modelId: string
  provider: ModelProvider
  contextLength?: number
  supportsImageInput?: boolean
}

export type PrepareModelOptions = {
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

export type ModelHostOptions = {
  llama?: LlamaCppRuntime
  env?: NodeJS.ProcessEnv
}

export class ModelHost {
  readonly llama: LlamaCppRuntime
  client: InferenceClient | undefined
  selectedId: string | undefined
  selectedProvider: ModelProvider | undefined
  pairEngine: PairEngine | undefined
  supportsImageInput: boolean | undefined
  autoCompactAtTokens = autoCompactThreshold()
  activeLocal: ActiveLocalModel | undefined
  #prepareId = 0
  #selectionId = 0
  #selectionController: AbortController | undefined
  #selectionTail: Promise<void> = Promise.resolve()

  constructor(options: ModelHostOptions = {}) {
    this.llama = options.llama ?? new LlamaCppRuntime({ env: options.env })
  }

  applySavedSelection(settings: LocalSettings) {
    this.selectedId = settings.model
    this.selectedProvider =
      settings.modelProvider ?? (settings.model ? (isLocalModelId(settings.model) ? "local" : "fireworks") : undefined)
    this.pairEngine = settings.pairEngine
    this.supportsImageInput = settings.modelSupportsImageInput
    this.autoCompactAtTokens = autoCompactThreshold(
      compactionContextLength({
        provider: this.selectedProvider,
        contextLength: settings.modelContextLength,
      }),
    )

    if (settings.fireworksApiKey && this.selectedId && this.selectedProvider === "fireworks") {
      this.client = new FireworksClient({ apiKey: settings.fireworksApiKey, model: this.selectedId })
    }
    const pairEndpoint = pairEndpointForEngine(settings.pairEndpoints ?? {}, this.pairEngine)
    if (pairEndpoint && this.selectedId && this.selectedProvider === "pair") {
      this.client = new PairClient({ baseURL: pairEndpoint, model: this.selectedId })
    }
  }

  cancelPrepare() {
    this.#prepareId += 1
  }

  cancelSelection() {
    this.#selectionId += 1
    this.#selectionController?.abort()
  }

  async waitForSelection() {
    await this.#selectionTail
  }

  enqueueSelection<T>(operation: (signal: AbortSignal, selectionId: number) => Promise<T>): Promise<T | undefined> {
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

  async persistSelection(selected: CatalogModel, options: PersistSelectionOptions): Promise<CatalogModel> {
    let prepared: PreparedModelSelection | undefined
    try {
      prepared = await this.prepare(selected, options)
      if (options.wrap) prepared = options.wrap(prepared)
      options.signal.throwIfAborted()
      await options.persist(prepared.model)
    } catch (error) {
      if (prepared) {
        try {
          await prepared.rollback({ restorePrevious: !options.signal.aborted && options.isClosed?.() !== true })
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

  async prepare(model: CatalogModel, options: PrepareModelOptions): Promise<PreparedModelSelection> {
    const prepareId = ++this.#prepareId
    const previousLocal = this.activeLocal
    const exiting = () => options.isExiting?.() === true
    const restoreIfActive = async (error?: unknown) => {
      if (!options.signal.aborted && !exiting()) await this.restorePrevious(previousLocal, error, options.signal)
    }

    if (isLocalCatalogModel(model)) {
      const spec = findLocalModel(model.id)
      if (!spec) throw new Error(`Unknown local model: ${model.id}`)
      const hardware = await detectHardware()
      options.signal.throwIfAborted()
      const fit = fitLocalModel(spec, hardware)
      let serving: LocalServingEndpoint
      try {
        serving = await this.llama.ensureServing(spec, fit, hardware, {
          signal: options.signal,
          onProgress: (progress) => {
            if (prepareId !== this.#prepareId || options.signal.aborted || exiting()) return
            options.onLocalProgress?.(progress)
          },
        })
        options.signal.throwIfAborted()
      } catch (error) {
        await restoreIfActive(error)
        throw error
      }
      const activeModel = { ...model, contextLength: serving.contextLength }
      return transactionalSelection(activeModel, {
        commit: () => {
          this.activeLocal = { spec, fit, hardware, contextLength: serving.contextLength }
          this.activate(activeModel, new LlamaCppClient({ model: spec.id, inferenceURL: serving.inferenceURL }))
        },
        rollback: async ({ restorePrevious }) => {
          if (restorePrevious) await this.restorePrevious(previousLocal, undefined, options.signal)
        },
      })
    }

    if (isPairCatalogModel(model)) {
      const client = new PairClient({ baseURL: model.baseURL, model: model.id })
      try {
        await this.llama.stop()
        options.signal.throwIfAborted()
      } catch (error) {
        await restoreIfActive(error)
        throw error
      }
      return transactionalSelection(model, {
        commit: () => {
          this.activeLocal = undefined
          this.activate(model, client)
        },
        rollback: async ({ restorePrevious }) => {
          if (restorePrevious) await this.restorePrevious(previousLocal, undefined, options.signal)
        },
      })
    }

    if (!options.fireworksApiKey) throw new Error("Fireworks API key is required.")
    try {
      await this.llama.stop()
      options.signal.throwIfAborted()
    } catch (error) {
      await restoreIfActive(error)
      throw error
    }
    const client = new FireworksClient({ apiKey: options.fireworksApiKey, model: model.id })
    return transactionalSelection(model, {
      commit: () => {
        this.activeLocal = undefined
        this.activate(model, client)
      },
      rollback: async ({ restorePrevious }) => {
        if (restorePrevious) await this.restorePrevious(previousLocal, undefined, options.signal)
      },
    })
  }

  async restorePrevious(previous: ActiveLocalModel | undefined, originalError?: unknown, signal?: AbortSignal) {
    try {
      if (!previous) {
        await this.llama.stop()
        return
      }
      const serving = await this.llama.ensureServing(previous.spec, previous.fit, previous.hardware, { signal })
      signal?.throwIfAborted()
      previous.contextLength = serving.contextLength
      this.activeLocal = previous
      this.client = new LlamaCppClient({ model: previous.spec.id, inferenceURL: serving.inferenceURL })
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
    if (options.provider === "local") {
      const spec = findLocalModel(options.modelId)
      if (!spec) throw new Error(`Unknown local model: ${options.modelId}`)
      const hardware = await detectHardware()
      const fit = fitLocalModel(spec, hardware)
      const serving = await this.llama.ensureServing(spec, fit, hardware, { signal: options.signal })
      const client = new LlamaCppClient({ model: spec.id, inferenceURL: serving.inferenceURL })
      const model = catalogModelFromSpec(spec, serving.contextLength)
      this.activeLocal = { spec, fit, hardware, contextLength: serving.contextLength }
      this.activate(model, client)
      return {
        client,
        modelId: spec.id,
        provider: "local",
        contextLength: serving.contextLength,
        supportsImageInput: spec.supportsImageInput,
      }
    }

    if (options.provider === "pair") {
      if (!options.pairEndpoint) throw new Error("NVIDIA PAIR endpoint is not configured for the selected engine.")
      const client = new PairClient({ baseURL: options.pairEndpoint, model: options.modelId })
      await this.llama.stop()
      this.activate(
        {
          provider: "pair",
          id: options.modelId,
          displayName: options.modelId,
          baseURL: options.pairEndpoint,
          engine: options.pairEngine ?? "ollama",
          supportsImageInput: options.supportsImageInput ?? false,
        },
        client,
      )
      return {
        client,
        modelId: options.modelId,
        provider: "pair",
        contextLength: compactionContextLength({ provider: "pair" }),
        supportsImageInput: options.supportsImageInput,
      }
    }

    if (!options.fireworksApiKey) throw new Error("Fireworks API key is not configured.")
    const client = new FireworksClient({ apiKey: options.fireworksApiKey, model: options.modelId })
    await this.llama.stop()
    this.activate(
      {
        provider: "fireworks",
        id: options.modelId,
        displayName: options.modelId,
        contextLength: options.contextLength,
        supportsImageInput: options.supportsImageInput ?? false,
      },
      client,
    )
    return {
      client,
      modelId: options.modelId,
      provider: "fireworks",
      contextLength: options.contextLength,
      supportsImageInput: options.supportsImageInput,
    }
  }

  async stop() {
    await this.llama.stop()
  }
}

export async function resolveFireworksServing(
  apiKey: string,
  modelId: string,
  options: { fast?: boolean; signal: AbortSignal },
) {
  const models = await listToolCapableModels(apiKey, { signal: options.signal })
  const selected = findFireworksModel(models, modelId)
  if (!selected) throw new Error(`Model is not a tool-capable Fireworks serverless model: ${modelId}`)
  return {
    selected,
    serving: fireworksServingModel(selected, useFastServingPath(modelId, options.fast)),
  }
}

function transactionalSelection(
  model: CatalogModel,
  actions: {
    commit: () => void
    rollback: (options: { restorePrevious: boolean }) => Promise<void>
  },
): PreparedModelSelection {
  let finalized = false
  return {
    model,
    commit: () => {
      if (finalized) return
      finalized = true
      actions.commit()
    },
    rollback: async (options) => {
      if (finalized) return
      finalized = true
      await actions.rollback(options)
    },
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
