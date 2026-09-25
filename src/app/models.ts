import { autoCompactThreshold } from "../core/compaction.js"
import {
  FireworksClient,
  fireworksReasoningEffort,
  listToolCapableModels,
} from "../inference/client.js"
import { compactionContextLength, requireLocalContextLength } from "../inference/context-policy.js"
import { describeError } from "../inference/errors.js"
import { detectHardware, type HardwareProbe } from "../inference/hardware.js"
import {
  formatLocalLoadStatus,
  LlamaCppRuntime,
  type LocalLoadProgress,
} from "../inference/llama-runtime.js"
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
import type { ModelPickerStatus } from "../inference/picker-catalog.js"
import {
  findFireworksModel,
  fireworksServingModel,
  useFastServingPath,
} from "../inference/serving-path.js"
import type {
  CatalogModel,
  ChatMessage,
  CompleteOptions,
  FireworksModel,
  InferenceClient,
  ModelProvider,
  PairEngine,
  StreamChatOptions,
} from "../inference/types.js"
import { isLocalCatalogModel, isPairCatalogModel } from "../inference/types.js"
import type { LocalSettings } from "../local/settings.js"

type ActiveLocalModel = {
  spec: LocalModelSpec
  fit: LocalModelFit
  hardware: HardwareProbe
  contextLength: number
  /** Parallel sequences the serving endpoint accepts; the gate's capacity while it is active. */
  slots: number
}

/** Held for exactly one model request; releasing twice is a no-op. */
export type InferenceLease = { release(): void }

type GateWaiter = {
  owner: number
  grant: (lease: InferenceLease) => void
  abort: () => void
}

/**
 * Admission of model requests to the serving endpoint: at most `capacity` stream at once and the
 * rest wait in one FIFO queue across every owner. A managed llama-server has one slot per
 * configured parallel sequence; hosted and user-managed servers do their own admission, so the
 * gate stays unbounded for them.
 */
export class InferenceGate {
  #capacity: number
  readonly #active: { owner: number }[] = []
  readonly #waiting: GateWaiter[] = []
  readonly #listeners = new Set<() => void>()

  constructor(capacity = Infinity) {
    this.#capacity = capacity
  }

  get capacity() {
    return this.#capacity
  }

  /** Raising grants waiters in order; lowering only affects future grants. */
  setCapacity(capacity: number) {
    this.#capacity = capacity
    this.#grant()
    this.#notify()
  }

  get active() {
    return this.#active.length
  }

  get waiting() {
    return this.#waiting.length
  }

  /** An owner has a request waiting behind another owner's slot. */
  isWaiting(owner: number) {
    return this.#waiting.some((waiter) => waiter.owner === owner)
  }

  /** Resolves with a lease once a slot is free; rejects with an AbortError while still waiting. */
  acquire(owner: number, signal?: AbortSignal): Promise<InferenceLease> {
    if (signal?.aborted) return Promise.reject(gateAbortError())
    if (this.#waiting.length === 0 && this.#active.length < this.#capacity) {
      const lease = this.#lease(owner)
      this.#notify()
      return Promise.resolve(lease)
    }
    return new Promise<InferenceLease>((resolve, reject) => {
      const waiter: GateWaiter = {
        owner,
        grant: (lease) => {
          signal?.removeEventListener("abort", waiter.abort)
          resolve(lease)
        },
        abort: () => {
          const index = this.#waiting.indexOf(waiter)
          if (index === -1) return
          this.#waiting.splice(index, 1)
          reject(gateAbortError())
          this.#notify()
        },
      }
      this.#waiting.push(waiter)
      signal?.addEventListener("abort", waiter.abort, { once: true })
      this.#notify()
    })
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #lease(owner: number): InferenceLease {
    const entry = { owner }
    this.#active.push(entry)
    return {
      release: () => {
        this.#active.splice(this.#active.indexOf(entry), 1)
        this.#grant()
        this.#notify()
      },
    }
  }

  #grant() {
    while (this.#waiting.length > 0 && this.#active.length < this.#capacity) {
      const waiter = this.#waiting.shift()
      if (waiter) waiter.grant(this.#lease(waiter.owner))
    }
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }
}

function gateAbortError() {
  return new DOMException("The model request was cancelled while waiting for a slot.", "AbortError")
}

/**
 * One owner's view of the shared client: every stream or completion holds a gate lease from the
 * request to the end of its stream, so tool execution between requests never occupies a slot.
 * Token counting runs ungated. Identity is stable while the inner client is.
 */
export class GatedInferenceClient implements InferenceClient {
  countTokens?: (options: StreamChatOptions) => Promise<number>

  constructor(
    readonly inner: InferenceClient,
    readonly gate: InferenceGate,
    readonly owner: number,
  ) {
    if (inner.countTokens) this.countTokens = inner.countTokens.bind(inner)
  }

  get model() {
    return this.inner.model
  }

  async *streamChat(options: StreamChatOptions) {
    const lease = await this.gate.acquire(this.owner, options.signal)
    try {
      yield* this.inner.streamChat(options)
    } finally {
      lease.release()
    }
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    const lease = await this.gate.acquire(this.owner, options.signal)
    try {
      return await this.inner.complete(messages, options)
    } finally {
      lease.release()
    }
  }
}

/**
 * Lifecycle of the selected model's inference client. Prompts are only accepted in the `ready`
 * state, which is exactly "a client exists".
 */
export type ModelState = "unconfigured" | "starting" | "ready" | "failed"

/**
 * Progress or terminal error of a model load in flight, keyed by picker row. Progress entries
 * clear when the load completes; error entries stay until the next selection attempt so an open
 * picker can show the failure.
 */
export type ModelLoad = { modelId: string; status: ModelPickerStatus }

type PreparedModelSelection = {
  /** The exact serving model resolved during preparation; its client arrives with commit. */
  selection: ModelSelection
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

type PrepareModelOptions = {
  fireworksApiKey?: string
  signal: AbortSignal
  isExiting?: () => boolean
  /** Other sessions still run on the managed server: a hosted selection leaves it serving. */
  keepLocal?: boolean
  onLocalProgress?: (progress: LocalLoadProgress) => void
}

export type PersistSelectionOptions = PrepareModelOptions & {
  persist: (serving: CatalogModel) => Promise<void>
  isClosed?: () => boolean
  wrap?: (prepared: PreparedModelSelection) => PreparedModelSelection
  /** The picker row that shows progress and failure; PAIR and oMLX rows are keyed by selectionKey. */
  loadKey?: string
}

type ModelHostOptions = {
  llama?: LlamaCppRuntime
  env?: NodeJS.ProcessEnv
}

/** What one session runs on: a model, and its client once that model serves. */
export type ModelSelection = {
  model: CatalogModel
  /** Undefined until the capability is known; a saved hosted selection may predate it. */
  supportsImageInput: boolean | undefined
  client: InferenceClient | undefined
}

/** Hosted and user-managed servers do their own admission; their requests never wait here. */
const OPEN_GATE = new InferenceGate()

/**
 * The shared side of model serving: the managed llama-server and its admission gate, the
 * configured endpoints, thinking preferences, and the selection queue. Which model a session runs
 * on is the session's own; the host only reports which local model serves, or none.
 */
export class ModelHost {
  readonly llama: LlamaCppRuntime
  readonly gate = new InferenceGate()
  omlx: OmlxSettings | undefined
  activeLocal: ActiveLocalModel | undefined
  localThinking: LocalThinkingPreferences = {}
  load: ModelLoad | undefined
  /** Adapters set this to show one-time serving notices, such as a backend fallback. */
  onNotice: ((message: string) => void) | undefined
  /** The application points every local session at what the server serves, or at nothing. */
  onLocal: ((selection: ModelSelection | undefined) => void) | undefined
  /** Per-owner gated views; an entry is stale once its inner client is replaced. */
  readonly #gated = new Map<number, GatedInferenceClient>()
  #state: Exclude<ModelState, "ready"> = "unconfigured"
  #error: string | undefined
  #selecting = 0
  #prepareId = 0
  #selectionId = 0
  #selectionController: AbortController | undefined
  #selectionTail: Promise<void> = Promise.resolve()
  readonly #listeners = new Set<() => void>()

  constructor(options: ModelHostOptions = {}) {
    this.llama = options.llama ?? new LlamaCppRuntime({ env: options.env })
  }

  /**
   * The gated view an owner sends its selection's requests through; none until the model
   * serves.
   */
  clientFor(
    owner: number,
    selection: ModelSelection | undefined,
  ): GatedInferenceClient | undefined {
    const client = selection?.client
    if (!client) return undefined
    const memo = this.#gated.get(owner)
    if (memo?.inner === client) return memo
    const gate = selection.model.provider === "local" ? this.gate : OPEN_GATE
    const gated = new GatedInferenceClient(client, gate, owner)
    this.#gated.set(owner, gated)
    return gated
  }

  /** The state behind a selection without a client: its server starting, failed, or unset. */
  get state() {
    return this.#state
  }

  get error() {
    return this.#error
  }

  /** A selection request is open: from enqueue until it commits, fails, or is superseded. */
  get selecting() {
    return this.#selecting > 0
  }

  setState(state: Exclude<ModelState, "ready">, error?: string) {
    this.#state = state
    this.#error = error
    this.#notify()
  }

  setLoad(load: ModelLoad | undefined) {
    this.load = load
    this.#notify()
  }

  /** Notifies about every change of serving, state, load, or selection activity. */
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }

  applySettings(settings: LocalSettings) {
    this.omlx = settings.omlx
    this.localThinking = { ...settings.localThinking }
  }

  /**
   * The saved model as the first session's selection, with a client when settings can build one
   * outright: Fireworks with a key, PAIR with its endpoint. Local and oMLX models get theirs once
   * their server answers.
   */
  savedSelection(settings: LocalSettings): ModelSelection | undefined {
    const id = settings.model
    if (!id) return undefined
    const provider = settings.modelProvider ?? (isLocalModelId(id) ? "local" : "fireworks")
    if (provider === "local") {
      const spec = findLocalModel(id)
      if (!spec) return undefined
      const model = catalogModelFromSpec(spec, settings.modelContextLength)
      return { model, supportsImageInput: spec.supportsImageInput, client: undefined }
    }
    const supportsImageInput = settings.modelSupportsImageInput
    const shared = {
      id,
      displayName: settings.modelDisplayName ?? id,
      contextLength: settings.modelContextLength,
      supportsImageInput: supportsImageInput === true,
    }
    // A server selection whose endpoint is gone stays selected without a client, so setup can ask
    // for the endpoint again instead of forgetting the model.
    if (provider === "omlx") {
      const model: CatalogModel = { provider, ...shared, baseURL: this.omlx?.baseURL ?? "" }
      return { model, supportsImageInput, client: undefined }
    }
    if (provider === "pair") {
      const engine = settings.pairEngine ?? "ollama"
      const baseURL = pairEndpointForEngine(settings.pairEndpoints ?? {}, engine) ?? ""
      const model: CatalogModel = { provider, ...shared, baseURL, engine }
      const client = baseURL ? createPairClient({ baseURL, model: id, engine }) : undefined
      return { model, supportsImageInput, client }
    }
    const model: CatalogModel = { provider, ...shared, fastId: settings.modelFastId }
    const client = settings.fireworksApiKey
      ? new FireworksClient({ apiKey: settings.fireworksApiKey, model: id })
      : undefined
    return { model, supportsImageInput, client }
  }

  cancelPrepare() {
    this.#prepareId += 1
  }

  /**
   * The compaction trigger for a model: its window less the output one turn may need. A high
   * thinking effort can spend 16K tokens reasoning, a lower one about half that.
   */
  autoCompactAtTokens(model: CatalogModel | undefined) {
    if (!model) return autoCompactThreshold()
    const effort =
      model.provider === "local"
        ? (this.localThinking[model.id] ?? localThinkingCapability(model.id)?.defaultLevel)
        : model.provider === "fireworks"
          ? fireworksReasoningEffort(model.id)
          : undefined
    const reserve = effort === "high" || effort === "xhigh" || effort === "max" ? 16_384 : 8_192
    return autoCompactThreshold(compactionContextLength(model), reserve)
  }

  thinkingState(model: CatalogModel | undefined): LocalThinkingState | null {
    if (model?.provider !== "local") return null
    const capability = localThinkingCapability(model.id)
    if (!capability) return null
    return {
      ...capability,
      modelId: model.id,
      selected: this.localThinking[model.id] ?? "default",
    }
  }

  #localClient(model: string, inferenceURL: string) {
    return new LlamaCppClient({
      model,
      inferenceURL,
      thinkingLevel: () => this.localThinking[model],
      assertServing: () => this.llama.assertServing(),
    })
  }

  /** The managed server now serves `active`; every local session follows. */
  #serve(
    active: ActiveLocalModel,
    inferenceURL: string,
  ): ModelSelection & { client: InferenceClient } {
    this.activeLocal = active
    this.gate.setCapacity(active.slots)
    const selection = {
      model: catalogModelFromSpec(active.spec, active.contextLength),
      supportsImageInput: active.spec.supportsImageInput,
      client: this.#localClient(active.spec.id, inferenceURL),
    }
    this.onLocal?.(selection)
    this.#notify()
    return selection
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
    this.#selecting += 1
    this.#notify()
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
      this.#selecting -= 1
      this.#notify()
    })
  }

  /**
   * Prepares, persists, and commits one selection, reporting local progress and the outcome on
   * the picker row. A failure that was not a cancellation stays on the row until the next attempt;
   * a restored previous model stays ready, otherwise the host is failed with the message.
   */
  async persistSelection(
    selected: CatalogModel,
    options: PersistSelectionOptions,
  ): Promise<ModelSelection> {
    const modelId = options.loadKey ?? selected.id
    this.setLoad(undefined)
    let prepared: PreparedModelSelection | undefined
    try {
      prepared = await this.prepare(selected, {
        ...options,
        onLocalProgress: (progress) => {
          this.setLoad({
            modelId,
            status: { label: formatLocalLoadStatus(progress), kind: "progress" },
          })
          options.onLocalProgress?.(progress)
        },
      })
      if (options.wrap) prepared = options.wrap(prepared)
      options.signal.throwIfAborted()
      await options.persist(prepared.selection.model)
    } catch (error) {
      let failure = error
      if (prepared) {
        try {
          await prepared.rollback({
            restorePrevious: !options.signal.aborted && options.isClosed?.() !== true,
          })
        } catch (rollbackError) {
          failure = new AggregateError(
            [error, rollbackError],
            `${describeError(error)} The previous model could not be restored.`,
          )
        }
      }
      if (options.signal.aborted || options.isClosed?.() === true || isAbortError(failure)) {
        this.setLoad(undefined)
        throw failure
      }
      const message = describeError(failure)
      if (!this.activeLocal) this.setState("failed", message)
      this.setLoad({ modelId, status: { label: `Failed: ${message}`, kind: "error" } })
      throw failure
    }

    // No await is allowed between persistence and commit: they become visible
    // as one selection before another queued request can supersede it.
    prepared.commit()
    this.setLoad(undefined)
    return prepared.selection
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
    const prepared = (
      selection: ModelSelection,
      commit: () => void = () => {},
    ): PreparedModelSelection => {
      let finalized = false
      return {
        selection,
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
          onNotice: (message) => {
            if (prepareId !== this.#prepareId || options.signal.aborted || exiting()) return
            this.onNotice?.(message)
          },
        }),
      )
      const active = {
        spec: selectedSpec,
        fit,
        hardware,
        contextLength: serving.contextLength,
        slots: serving.slots,
      }
      const selection: ModelSelection = {
        model: catalogModelFromSpec(selectedSpec, serving.contextLength),
        supportsImageInput: selectedSpec.supportsImageInput,
        client: undefined,
      }
      return prepared(selection, () =>
        Object.assign(selection, this.#serve(active, serving.inferenceURL)),
      )
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
    // The server keeps serving the sessions that still run on it.
    if (!options.keepLocal) await guarded(() => this.stopLocal())
    return prepared({ model, supportsImageInput: model.supportsImageInput, client })
  }

  /**
   * A saved selection without a window is budgeted like a 128K model; the catalog's reported
   * window is better when it can be fetched, so this refreshes it best-effort before activation.
   */
  async fireworksContextLength(
    apiKey: string,
    model: FireworksModel,
    signal?: AbortSignal,
  ): Promise<FireworksModel> {
    try {
      const { serving } = await resolveFireworksServing(apiKey, model.id, { signal })
      return serving.contextLength === undefined
        ? model
        : { ...model, contextLength: serving.contextLength }
    } catch {
      signal?.throwIfAborted()
      return model
    }
  }

  async restorePrevious(
    previous: ActiveLocalModel | undefined,
    originalError?: unknown,
    signal?: AbortSignal,
  ) {
    try {
      if (!previous) {
        await this.stopLocal()
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
      previous.slots = serving.slots
      this.#serve(previous, serving.inferenceURL)
    } catch (restoreError) {
      if (originalError === undefined) throw restoreError
      throw new AggregateError(
        [originalError, restoreError],
        `${describeError(originalError)} The previous local model could not be restored.`,
      )
    }
  }

  /** Connects a model outright, outside the selection queue, as the headless CLI does. */
  async connect(
    options: ConnectModelOptions,
  ): Promise<ModelSelection & { client: InferenceClient }> {
    const { provider, modelId } = options
    if (provider === "local") {
      const spec = findLocalModel(modelId)
      if (!spec) throw new Error(`Unknown local model: ${modelId}`)
      const hardware = await detectHardware()
      const fit = fitLocalModel(spec, hardware)
      const selectedSpec = fit.model
      const serving = await this.llama.ensureServing(selectedSpec, fit, hardware, {
        signal: options.signal,
        onNotice: (message) => this.onNotice?.(message),
      })
      const active = {
        spec: selectedSpec,
        fit,
        hardware,
        contextLength: serving.contextLength,
        slots: serving.slots,
      }
      return this.#serve(active, serving.inferenceURL)
    }
    if (provider === "omlx") {
      if (!this.omlx) throw new Error("oMLX is not configured. Connect it in Local servers.")
      const models = await discoverOmlxModels(this.omlx, { signal: options.signal })
      const model = models.find((entry) => entry.id === modelId)
      if (!model) throw new Error(`oMLX model is no longer available: ${modelId}`)
      requireLocalContextLength(model.contextLength, "oMLX")
      const client = this.omlxClient(model.id, model.baseURL)
      await this.stopLocal()
      options.signal?.throwIfAborted()
      return { model, supportsImageInput: model.supportsImageInput, client }
    }
    const supportsImageInput = options.supportsImageInput ?? false
    await this.stopLocal()
    if (provider === "pair") {
      const baseURL = options.pairEndpoint
      if (!baseURL)
        throw new Error("Local model server endpoint is not configured for the selected engine.")
      const engine = options.pairEngine ?? "ollama"
      return {
        model: { provider, id: modelId, displayName: modelId, baseURL, engine, supportsImageInput },
        supportsImageInput,
        client: createPairClient({ baseURL, model: modelId, engine }),
      }
    }
    if (!options.fireworksApiKey) throw new Error("Fireworks API key is not configured.")
    let model: FireworksModel = {
      provider,
      id: modelId,
      displayName: modelId,
      contextLength: options.contextLength,
      supportsImageInput,
    }
    if (model.contextLength === undefined)
      model = await this.fireworksContextLength(options.fireworksApiKey, model, options.signal)
    return {
      model,
      supportsImageInput: options.supportsImageInput,
      client: new FireworksClient({ apiKey: options.fireworksApiKey, model: modelId }),
    }
  }

  /** Stops the managed server; local sessions keep their model but lose the client. */
  async stopLocal() {
    await this.llama.stop()
    if (!this.activeLocal) return
    this.activeLocal = undefined
    this.gate.setCapacity(Infinity)
    this.onLocal?.(undefined)
    this.#notify()
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
  options: { fast?: boolean; signal?: AbortSignal },
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

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
