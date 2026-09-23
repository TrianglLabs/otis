import { homedir } from "node:os"
import { isAbsolute, parse, relative, resolve, sep } from "node:path"
import type { ArtifactReference } from "../artifacts/types.js"
import { requestContextEstimator } from "../core/compaction.js"
import { loadProjectContext } from "../core/context.js"
import { validateAttachments } from "../inference/attachments.js"
import { FireworksClient, listToolCapableModels } from "../inference/client.js"
import { requireLocalContextLength } from "../inference/context-policy.js"
import { errorMessage } from "../inference/errors.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../inference/gguf-cache.js"
import { validateImageAttachments } from "../inference/images.js"
import { formatLocalLoadStatus } from "../inference/llama-runtime.js"
import {
  catalogModelFromSpec,
  findLocalModel,
  type LocalModelSpec,
} from "../inference/local-catalog.js"
import type { LocalThinkingState } from "../inference/local-thinking.js"
import { createUserMessage, imageAttachmentsFromMessages } from "../inference/messages.js"
import {
  createPairClient,
  type PairEndpoints,
  pairEndpointForEngine,
  pairModelKey,
} from "../inference/pair.js"
import {
  type FireworksPickerChoice,
  isSelectablePickerItem,
  type ModelPickerChoice,
  toLocalCatalogModel,
  toOmlxCatalogModel,
  toPairCatalogModel,
} from "../inference/picker-catalog.js"
import {
  baseFireworksModelId,
  findFireworksModel,
  fireworksServingModel,
  isFastFireworksModel,
} from "../inference/serving-path.js"
import type {
  AttachmentContentPart,
  CatalogModel,
  ChatMessage,
  ContextFile,
  FireworksModel,
  ModelProvider,
  OutputCapabilities,
  UserChatMessage,
} from "../inference/types.js"
import {
  clearSelectedModel,
  type LocalSettings,
  loadLocalSettings,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveLocalServers,
  saveLocalThinking,
  savePermissionMode,
  saveSelectedModel,
} from "../local/settings.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  loadProjectPermissionRules,
  type PermissionMode,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadSkillCatalog, type SkillCatalog } from "../skills/catalog.js"
import { providerTools } from "../tools/index.js"
import { ParallelClient } from "../web/client.js"
import { ArtifactStore } from "./artifacts.js"
import {
  Conversation,
  type ConversationEvent,
  type PendingPermission,
  type TurnPhase,
  type TurnSpeed,
} from "./conversation.js"
import {
  type LocalServerDiscoveryOptions,
  type LocalServerInputs,
  prepareLocalServers,
} from "./local-servers.js"
import {
  isAbortError,
  ModelHost,
  type ModelLoad,
  type ModelState,
  resolveFireworksServing,
} from "./models.js"
import { SessionCoordinator } from "./sessions.js"
import { type SubagentStatus, SubagentTraces } from "./subagents.js"
import { type TranscriptChange, TranscriptStore } from "./transcript.js"

type ApplicationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  isBusy?: () => boolean
  isExiting?: () => boolean
  outputCapabilities?: OutputCapabilities
}

/** One delegated run as a panel lists it: identity, lifecycle, and its tool-call count. */
export type SubagentSummary = {
  toolCallId: string
  title: string
  status: SubagentStatus
  durationMs?: number
  tools: number
}

/** The mutable application state outside the transcript, shared by every interface. */
export type AppStatus = {
  busy: boolean
  phase: TurnPhase
  /** Generation speed of the latest model request; null until the current turn streams. */
  speed: TurnSpeed | null
  model: {
    id: string
    provider: ModelProvider
    displayName?: string
    supportsImageInput: boolean
  } | null
  modelState: ModelState
  modelError: string | undefined
  modelLoad: ModelLoad | null
  session: { id: string; title: string } | null
  diffs: { added: number; removed: number }
  contextTokens: number
  contextLimit: number
  permission: PendingPermission | null
  localThinking: LocalThinkingState | null
  permissionMode: PermissionMode
  /** Fast serving for the selected hosted model: whether it has a fast path, and whether it is on. */
  fastServing: { available: boolean; enabled: boolean }
  hostedConfigured: boolean
  pairEndpoints: PairEndpoints
  omlx: { baseURL: string; hasApiKey: boolean } | null
  subagents: SubagentSummary[]
}

/**
 * Status-affecting changes carry no payload: adapters diff `status()`. Transcript edits and
 * conversation events carry theirs.
 */
export type AppEvent =
  | { type: "status" }
  | { type: "transcript"; change: TranscriptChange }
  | ConversationEvent

/**
 * The outcome of a model transaction. A superseded or aborted request reports
 * SELECTION_SUPERSEDED or SELECTION_CANCELLED rather than a failure.
 */
export type SelectionResult = { ok: true } | { ok: false; reason: string }

export type SelectModelOptions = {
  signal?: AbortSignal
  /** A key not yet saved (onboarding); it becomes the application's once the selection commits. */
  fireworksApiKey?: string
  /** Replaces the default `saveSelectedModel`, e.g. to save a new key and model together. */
  persist?: (serving: CatalogModel) => Promise<void>
}

const MODEL_START_CANCELLED = "The model start was cancelled."
const MODEL_STARTING = "The model is still starting. Try again in a moment."
const MODEL_SWITCHING = "A model switch is in progress. Try again in a moment."
const NO_MODEL = "No model is configured. Set up inference with the Otis CLI first."
export const SELECTION_CANCELLED = "The selection was cancelled."
export const SELECTION_SUPERSEDED = "The selection was superseded."
export const NO_FAST_SERVING = "Fast serving is not available for this model."
export const NO_TOOL_MODELS = "The hosted provider returned no public models with tool support."
const CANCELLED: SelectionResult = { ok: false, reason: SELECTION_CANCELLED }
const SUPERSEDED: SelectionResult = { ok: false, reason: SELECTION_SUPERSEDED }

export function isSelectionCancelled(result: SelectionResult) {
  return (
    !result.ok && (result.reason === SELECTION_CANCELLED || result.reason === SELECTION_SUPERSEDED)
  )
}

/** The catalog model behind a hosted picker row, without the row's own fields. */
function fireworksCatalogModel(choice: FireworksPickerChoice): FireworksModel {
  const { kind: _kind, available: _available, active: _active, status: _status, ...model } = choice
  return model
}

/** Picker rows are keyed the way the list keys them: oMLX and PAIR by selectionKey. */
function pickerKey(model: CatalogModel) {
  if (model.provider === "omlx") return `omlx:${model.id}`
  return model.provider === "pair" ? pairModelKey(model) : model.id
}

export class Application {
  readonly cwd: string
  readonly outputCapabilities: OutputCapabilities
  readonly transcript = new TranscriptStore()
  readonly artifacts: ArtifactStore
  readonly subagents = new SubagentTraces()
  readonly models: ModelHost
  readonly sessions: SessionCoordinator
  readonly conversation: Conversation
  readonly webClient = new ParallelClient()
  settings: LocalSettings
  projectContext: ContextFile[] = []
  skills!: SkillCatalog
  permissionMode: PermissionMode
  permissionRules: PermissionRule[]
  fireworksApiKey: string | undefined
  pairEndpoints: PairEndpoints
  /**
   * An adapter's own reasons not to admit a prompt or drive the queue (shutting down, switching
   * workspaces, opening a session), checked before the model's.
   */
  extraGate: (() => string | undefined) | undefined
  readonly #listeners = new Set<(event: AppEvent) => void>()
  /** A local-model deletion is in flight; other model transactions are refused until it settles. */
  #deleting = false
  /** One catalog lookup at a time resolves an unknown image capability for the selected model. */
  #imageSupport: { modelId: string; promise: Promise<void> } | undefined

  static async create(options: ApplicationOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd())
    const settings = await loadLocalSettings({ env: options.env })
    const app = new Application(cwd, settings, options)
    app.models.applySavedSelection(settings)
    // A saved selection without a client still needs its server (local, oMLX) or its key.
    if (!app.models.client)
      app.models.setState(app.hasConfiguredSelection() ? "starting" : "unconfigured")
    app.projectContext = loadProjectContext(cwd)
    app.skills = await loadSkillCatalog(cwd)
    app.permissionRules = [
      ...(settings.permissions?.rules ?? []),
      ...(await loadProjectPermissionRules(cwd)),
    ]
    return app
  }

  private constructor(cwd: string, settings: LocalSettings, options: ApplicationOptions) {
    const isExiting = options.isExiting ?? (() => false)
    this.cwd = cwd
    this.artifacts = new ArtifactStore(cwd)
    this.outputCapabilities = options.outputCapabilities ?? {}
    this.settings = settings
    this.fireworksApiKey = settings.fireworksApiKey
    this.pairEndpoints = { ...settings.pairEndpoints }
    this.permissionMode = settings.permissions?.defaultMode ?? DEFAULT_PERMISSION_MODE
    this.permissionRules = [...(settings.permissions?.rules ?? [])]
    this.models = new ModelHost({ env: options.env })
    this.sessions = new SessionCoordinator({
      cwd,
      transcript: this.transcript,
      subagents: this.subagents,
      client: () => this.models.client,
      isBusy: () => (options.isBusy?.() ?? false) || this.conversation.busy,
      isExiting,
      onReset: () => this.artifacts.clear(),
      onReplay: (messages, activities, session) =>
        this.artifacts.restore(messages, activities, session.artifactDirectory),
    })
    this.conversation = new Conversation({
      sessions: this.sessions,
      transcript: this.transcript,
      subagents: this.subagents,
      webClient: this.webClient,
      cwd,
      models: this.models,
      projectContext: () => this.projectContext,
      skills: () => this.skills,
      permissionPolicy: () => this.createPermissionPolicy(),
      isExiting,
      outputCapabilities: this.outputCapabilities,
      artifacts: this.artifacts,
      gate: () => this.admissionGate(),
    })
    this.models.subscribe(() => {
      this.#notify({ type: "status" })
      // Follow-ups parked by a model switch resume on the settled model, whether the switch
      // committed, failed, or was superseded.
      if (!this.models.selecting) this.conversation.drain()
    })
    this.sessions.subscribe(() => this.#notify({ type: "status" }))
    this.transcript.subscribe((change) => this.#notify({ type: "transcript", change }))
    this.conversation.subscribe((event) => this.#notify(event))
  }

  /**
   * Why a prompt cannot be admitted right now. Model switching and prompt admission are mutually
   * exclusive: preparation may stop the server the prompt would run on, and the busy window alone
   * does not cover the asynchronous selection span.
   */
  admissionGate(): string | undefined {
    const extra = this.extraGate?.()
    if (extra) return extra
    const { models } = this
    if (models.state === "starting") return MODEL_STARTING
    if (models.selecting) return MODEL_SWITCHING
    if (models.client) return undefined
    return models.error ?? NO_MODEL
  }

  /**
   * Fan-in of model, session, transcript, and conversation changes. Returns an unsubscribe
   * function.
   */
  subscribe(listener: (event: AppEvent) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(event: AppEvent) {
    for (const listener of this.#listeners) listener(event)
  }

  status(): AppStatus {
    const { models, sessions, conversation } = this
    const { selectedId } = models
    const fastServing = { available: false, enabled: false }
    if (models.selectedProvider === "fireworks" && selectedId) {
      fastServing.enabled = isFastFireworksModel(selectedId)
      fastServing.available =
        fastServing.enabled ||
        models.fastId !== undefined ||
        this.settings.fastServingModels?.includes(baseFireworksModelId(selectedId)) === true
    }
    return {
      busy: conversation.busy,
      phase: conversation.phase,
      speed: conversation.speed,
      model: selectedId
        ? {
            id: selectedId,
            provider: models.selectedProvider ?? "fireworks",
            supportsImageInput: models.supportsImageInput === true,
            ...(models.displayName ? { displayName: models.displayName } : {}),
          }
        : null,
      modelState: models.state,
      modelError: models.error,
      modelLoad: models.load ?? null,
      session: sessions.current ? { id: sessions.current.id, title: sessions.activeLabel() } : null,
      diffs: sessions.diffs,
      contextTokens: this.contextTokens(),
      contextLimit: models.autoCompactAtTokens,
      permission: conversation.permission,
      localThinking: models.thinkingState(),
      permissionMode: this.permissionMode,
      fastServing,
      hostedConfigured: Boolean(this.fireworksApiKey),
      pairEndpoints: { ...this.pairEndpoints },
      omlx: models.omlx
        ? { baseURL: models.omlx.baseURL, hasApiKey: Boolean(models.omlx.apiKey) }
        : null,
      subagents: this.subagents.all.map((trace) => ({
        toolCallId: trace.toolCallId,
        title: trace.title,
        status: trace.status,
        ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
        tools: trace.transcript.entries.filter((entry) => entry.kind === "tool").length,
      })),
    }
  }

  async setLocalThinking(model: string, level: string) {
    if (this.conversation.busy)
      throw new Error("Finish the current work before changing thinking effort.")
    if (this.models.selectedProvider !== "local" || this.models.selectedId !== model) {
      throw new Error("The selected local model has changed.")
    }
    const preferences = await saveLocalThinking(model, level)
    this.settings.localThinking = preferences
    this.models.localThinking = preferences
    this.models.refreshAutoCompact()
    this.transcript.invalidateContext()
  }

  /** Applies and persists the permission behavior for subsequent tool calls. */
  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode
    this.settings.permissions = {
      defaultMode: mode,
      rules: [...(this.settings.permissions?.rules ?? [])],
    }
    this.#notify({ type: "status" })
    await savePermissionMode(mode)
  }

  createPermissionPolicy() {
    return createPermissionPolicy({
      cwd: this.cwd,
      mode: this.permissionMode,
      rules: this.permissionRules,
    })
  }

  contextEstimator() {
    const tools = providerTools(this.models.selectedProvider ?? "fireworks").filter(
      (tool) => tool.name !== "skill" || this.skills.skills.length > 0,
    )
    return requestContextEstimator({
      tools,
      projectContext: this.projectContext,
      skills: tools.some((tool) => tool.name === "skill") ? this.skills.skills : [],
      outputCapabilities: this.outputCapabilities,
    })
  }

  contextTokens(pendingInput?: UserChatMessage) {
    const estimate = this.contextEstimator()
    const tokens =
      this.transcript.contextTokens(this.models.client) ?? estimate(this.transcript.history)
    return pendingInput ? tokens + estimate([pendingInput]) - estimate([]) : tokens
  }

  openArtifact(reference: ArtifactReference, version?: number) {
    return this.artifacts.open(reference, version)
  }

  /**
   * The prompt for one submission: attachments validated on their own and, together with the
   * images already in the conversation, against the model. An image capability the saved
   * selection predates is resolved once from the hosted catalog and remembered.
   */
  async buildPrompt(
    text: string,
    attachments: readonly AttachmentContentPart[],
    options: { history?: readonly ChatMessage[]; signal?: AbortSignal } = {},
  ): Promise<UserChatMessage> {
    validateAttachments(attachments)
    const message = createUserMessage(text, attachments)
    const images = imageAttachmentsFromMessages([
      ...(options.history ?? this.transcript.history),
      message,
    ])
    if (images.length === 0) return message
    validateImageAttachments(images)
    await this.ensureImageSupport(options.signal)
    return message
  }

  /**
   * Throws unless the selected model takes images. Local models answer from the catalog spec;
   * a hosted model whose saved selection predates the capability is looked up once and its
   * serving entry persisted. Server-discovered models (PAIR, oMLX) answer from their discovery.
   */
  async ensureImageSupport(signal?: AbortSignal): Promise<void> {
    const models = this.models
    if (models.supportsImageInput === true) return
    const modelId = models.selectedId
    if (!modelId) throw new Error("Select a model first.")
    const unsupported = () =>
      new Error(
        `${models.displayName ?? modelId} does not support image input. Choose a vision model.`,
      )
    if (models.supportsImageInput === false) throw unsupported()
    const apiKey = this.fireworksApiKey
    if (models.selectedProvider !== "fireworks" || !apiKey) {
      models.supportsImageInput =
        models.selectedProvider === "local" && findLocalModel(modelId)?.supportsImageInput === true
      this.#notify({ type: "status" })
      if (!models.supportsImageInput) throw unsupported()
      return
    }
    if (this.#imageSupport?.modelId !== modelId) {
      const promise = (async () => {
        const { serving } = await resolveFireworksServing(apiKey, modelId, {
          fast: isFastFireworksModel(modelId),
          signal,
        })
        if (models.selectedId !== modelId)
          throw new Error("The selected model changed while checking image support.")
        models.supportsImageInput = serving.supportsImageInput
        await saveSelectedModel(serving)
        this.#notify({ type: "status" })
      })().finally(() => {
        if (this.#imageSupport?.promise === promise) this.#imageSupport = undefined
      })
      this.#imageSupport = { modelId, promise }
    }
    await this.#imageSupport.promise
    if (!models.supportsImageInput) throw unsupported()
  }

  hasConfiguredSelection() {
    const { selectedId, selectedProvider, omlx, pairEngine } = this.models
    return Boolean(
      selectedId &&
        ((selectedProvider === "fireworks" && this.fireworksApiKey) ||
          selectedProvider === "local" ||
          (selectedProvider === "omlx" && omlx) ||
          (selectedProvider === "pair" && pairEndpointForEngine(this.pairEndpoints, pairEngine))),
    )
  }

  /**
   * Probes and persists local servers, refreshing the active PAIR or oMLX client onto the new
   * endpoints. A selection whose server no longer answers is invalidated and reported as failed.
   */
  async connectLocalServers(input: LocalServerInputs, options: LocalServerDiscoveryOptions = {}) {
    if (this.conversation.busy)
      throw new Error("Wait for the current turn before changing local servers.")
    const models = this.models
    try {
      return await this.#connectLocalServers(input, options)
    } catch (error) {
      if (models.selectedId && !models.client) models.setState("failed", errorMessage(error))
      throw error
    }
  }

  async #connectLocalServers(input: LocalServerInputs, options: LocalServerDiscoveryOptions) {
    const models = this.models
    const connection = await models.enqueueSelection(async (signal) => {
      const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal
      const servers = await prepareLocalServers(input, models.omlx, {
        ...options,
        signal: combined,
      })
      combined.throwIfAborted()
      const id = models.selectedId
      const omlxModel =
        id &&
        models.selectedProvider === "omlx" &&
        servers.omlxModels.find((entry) => entry.id === id)
      if (omlxModel) {
        try {
          requireLocalContextLength(omlxModel.contextLength, "oMLX")
        } catch (error) {
          // A refreshed limit invalidates the existing client only when it describes the same
          // server.
          if (omlxModel.baseURL === models.omlx?.baseURL) {
            models.client = undefined
            this.transcript.invalidateContext()
          }
          throw error
        }
      }
      await saveLocalServers(servers)
      this.pairEndpoints = servers.pairEndpoints
      models.omlx = servers.omlx
      if (id && models.selectedProvider === "pair") {
        const model = servers.pairModels.find(
          (entry) => entry.id === id && entry.engine === models.pairEngine,
        )
        if (model)
          models.activate(
            model,
            createPairClient({ baseURL: model.baseURL, model: id, engine: model.engine }),
          )
        else models.client = undefined
      }
      if (id && models.selectedProvider === "omlx") {
        if (omlxModel) models.activate(omlxModel, models.omlxClient(id, omlxModel.baseURL))
        else models.client = undefined
      }
      const provider = models.selectedProvider
      if (id && !models.client && (provider === "pair" || provider === "omlx")) {
        models.setState(
          "failed",
          "The local model server for the selected model is no longer available. Reconnect or choose another model.",
        )
      }
      this.transcript.invalidateContext()
      return servers
    })
    if (!connection) throw new Error("The connection was cancelled.")
    return connection
  }

  /**
   * Activates the saved selection through the selection queue: a model picked while the saved one
   * is still loading supersedes startup, so its late commit can never reactivate the old model
   * over the new one. Fireworks and PAIR clients already exist after `applySavedSelection`; a
   * saved local model still needs its managed llama-server started before any conversation can
   * run, and a saved oMLX model its server reached. Throws with the serving error when startup
   * fails and marks the host failed; a superseded, cancelled, or exiting startup leaves model state
   * to whoever took over. The previous selection is left untouched either way.
   */
  async startSavedSelection(
    options: { signal?: AbortSignal; isExiting?: () => boolean } = {},
  ): Promise<"ready" | "unconfigured" | "superseded"> {
    const models = this.models
    if (models.client) return "ready"
    if (!models.selectedId || !models.selectedProvider) {
      models.setState("unconfigured")
      return "unconfigured"
    }
    const result = await models.enqueueSelection(async (queued) => {
      const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
      const superseded = () => signal.aborted || options.isExiting?.() === true
      let result: "ready" | "unconfigured"
      try {
        result = await this.#startSavedSelection(signal, options.isExiting)
      } catch (error) {
        if (queued.aborted) return "superseded" as const
        if (superseded() || isAbortError(error)) throw error
        models.setLoad(undefined)
        models.setState("failed", errorMessage(error))
        throw error
      }
      if (superseded()) return result
      models.setLoad(undefined)
      if (!models.client) models.setState("unconfigured")
      return result
    })
    return result ?? "superseded"
  }

  async #startSavedSelection(
    signal: AbortSignal,
    isExiting?: () => boolean,
  ): Promise<"ready" | "unconfigured"> {
    const models = this.models
    if (models.client) return "ready"
    if (!models.selectedId || !models.selectedProvider) return "unconfigured"
    if (models.selectedProvider === "omlx") {
      await models.connect({ provider: "omlx", modelId: models.selectedId, signal })
      return "ready"
    }
    if (models.selectedProvider !== "local") return "unconfigured"
    const modelId = models.selectedId
    const spec = findLocalModel(modelId)
    if (!spec) throw new Error(`Unknown local model: ${modelId}`)
    const prepared = await models.prepare(
      catalogModelFromSpec(spec, this.settings.modelContextLength),
      {
        fireworksApiKey: this.fireworksApiKey,
        signal,
        isExiting,
        onLocalProgress: (progress) => {
          models.setLoad({
            modelId,
            status: { label: formatLocalLoadStatus(progress), kind: "progress" },
          })
        },
      },
    )
    if (signal.aborted) {
      await prepared.rollback({ restorePrevious: false })
      signal.throwIfAborted()
    }
    prepared.commit()
    return "ready"
  }

  /**
   * Cancels an in-flight selection and waits for it to settle. A selection aborted before it
   * started never ran its own cleanup, so a stale progress row is cleared here; cancelling the
   * saved model's startup leaves nothing to serve prompts, so it surfaces as a failed start and
   * the picker's active row becomes a real retry instead of a dead shortcut.
   */
  async cancelModelSelection() {
    const models = this.models
    models.cancelSelection()
    await models.waitForSelection()
    if (models.load?.status.kind === "progress") models.setLoad(undefined)
    if (models.state === "starting") models.setState("failed", MODEL_START_CANCELLED)
  }

  /**
   * Switches the selected model. The request joins the selection queue in click order (a newer
   * request supersedes one in flight), is prepared, persisted, and committed as one transaction,
   * and reports progress and failure on its picker row. A row that is already active with a live
   * client is a no-op; without a client it is a failed start and selecting it prepares again.
   */
  async selectModel(
    target: ModelPickerChoice | CatalogModel,
    options: SelectModelOptions = {},
  ): Promise<SelectionResult> {
    if (this.#deleting || this.conversation.busy)
      return { ok: false, reason: "Finish the current work before switching models." }
    const models = this.models
    const choice = "kind" in target ? target : undefined
    if (choice && !isSelectablePickerItem(choice)) {
      const label = "availabilityLabel" in choice ? choice.availabilityLabel : undefined
      return { ok: false, reason: label ?? "This model is not available on this machine." }
    }
    const selection = await models.enqueueSelection(async (queued): Promise<SelectionResult> => {
      const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
      if (signal.aborted) return SUPERSEDED
      const active = choice
        ? choice.active
        : models.selectedId === target.id && models.selectedProvider === target.provider
      // A managed server that died since it was ready must be restarted, not shortcut.
      const serving = target.provider !== "local" || models.llama.alive
      if (active && models.client && serving && target.provider !== "omlx") return { ok: true }
      // Defense in depth: no driver can start while a selection is open, so running work here
      // means a turn outlived the entry check. Parked follow-ups are safe until settle.
      if (this.conversation.busy)
        return { ok: false, reason: "Finish the current work before switching models." }
      const selected: CatalogModel = !choice
        ? target
        : choice.provider === "local"
          ? toLocalCatalogModel(choice)
          : choice.provider === "pair"
            ? toPairCatalogModel(choice)
            : choice.provider === "omlx"
              ? toOmlxCatalogModel(choice)
              : fireworksServingModel(
                  fireworksCatalogModel(choice),
                  this.fastServingEnabled(choice.id),
                )
      const fireworksApiKey = options.fireworksApiKey ?? this.fireworksApiKey
      try {
        await models.persistSelection(selected, {
          signal,
          fireworksApiKey,
          persist: options.persist ?? ((serving) => saveSelectedModel(serving)),
          loadKey: pickerKey(selected),
        })
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return CANCELLED
        return { ok: false, reason: errorMessage(error) }
      }
      if (options.fireworksApiKey) this.fireworksApiKey = options.fireworksApiKey
      this.#notify({ type: "status" })
      return { ok: true }
    })
    return selection ?? SUPERSEDED
  }

  fastServingEnabled(modelId: string) {
    return this.settings.fastServingModels?.includes(baseFireworksModelId(modelId)) === true
  }

  /**
   * Toggles Fast serving for the selected hosted model: it is re-selected on its fast or standard
   * path and the preference is persisted per base model id. The caller's catalog spares a fetch
   * when it already lists the model.
   */
  async setFastServing(
    fast: boolean,
    options: { catalog?: readonly FireworksModel[]; signal?: AbortSignal } = {},
  ): Promise<SelectionResult> {
    if (this.#deleting || this.conversation.busy)
      return { ok: false, reason: "Finish the current work before changing Fast serving." }
    const models = this.models
    if (models.selectedProvider !== "fireworks" || !models.selectedId)
      return { ok: false, reason: NO_FAST_SERVING }
    const selection = await models.enqueueSelection(async (queued): Promise<SelectionResult> => {
      const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
      const selectedId = models.selectedId
      const apiKey = this.fireworksApiKey
      if (!selectedId || models.selectedProvider !== "fireworks")
        return { ok: false, reason: NO_FAST_SERVING }
      if (isFastFireworksModel(selectedId) === fast) return { ok: true }
      if (signal.aborted) return SUPERSEDED
      let catalog = options.catalog
      try {
        if (!catalog?.length) {
          if (!apiKey) return { ok: false, reason: NO_FAST_SERVING }
          catalog = await listToolCapableModels(apiKey, { signal })
        }
      } catch (error) {
        return { ok: false, reason: errorMessage(error) }
      }
      const model = findFireworksModel(catalog, selectedId)
      if (!model?.fastId) return { ok: false, reason: NO_FAST_SERVING }
      const serving = fireworksServingModel(model, fast)
      try {
        await models.persistSelection(serving, {
          signal,
          fireworksApiKey: apiKey,
          persist: (saved) => saveFastServingSelection(saved as FireworksModel, fast),
        })
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return CANCELLED
        return { ok: false, reason: errorMessage(error) }
      }
      const enabled = new Set(this.settings.fastServingModels ?? [])
      if (fast) enabled.add(model.id)
      else enabled.delete(model.id)
      this.settings.fastServingModels = [...enabled].sort()
      this.#notify({ type: "status" })
      return { ok: true }
    })
    return selection ?? SUPERSEDED
  }

  /**
   * Validates a Fireworks API key against the hosted catalog, then persists and activates it: a
   * saved hosted model waiting on a key becomes chat-ready the moment the key lands. Returns the
   * verified catalog. `list` is the desktop's catalog seam.
   */
  async setFireworksApiKey(
    apiKey: string,
    options: { signal?: AbortSignal; list?: typeof listToolCapableModels } = {},
  ): Promise<FireworksModel[]> {
    const key = apiKey.trim()
    if (!key) throw new Error("Fireworks API key is required.")
    const catalog = await (options.list ?? listToolCapableModels)(key, { signal: options.signal })
    options.signal?.throwIfAborted()
    if (catalog.length === 0) throw new Error(NO_TOOL_MODELS)
    await saveFireworksApiKey(key)
    this.fireworksApiKey = key
    const { models } = this
    if (models.selectedProvider === "fireworks" && models.selectedId)
      models.client = new FireworksClient({ apiKey: key, model: models.selectedId })
    this.#notify({ type: "status" })
    return catalog
  }

  /**
   * Deletes a downloaded local model from the catalog, clearing the selection first when it is
   * active and restoring it if the removal fails. Runs inside the selection queue, so prompts are
   * refused meanwhile and shutdown waits for it; an open selection refuses the deletion instead of
   * being cancelled by it.
   */
  async deleteLocalModel(
    modelId: string,
  ): Promise<{ wasActive: boolean; remaining: LocalModelSpec[] }> {
    const models = this.models
    if (this.#deleting || this.conversation.busy || models.selecting)
      throw new Error("Finish the current work before deleting a model.")
    const spec = findLocalModel(modelId)
    if (!spec) throw new Error("That model is not in the local catalog.")
    this.#deleting = true
    try {
      const deleted = await models.enqueueSelection(async () => {
        const active = models.selectedProvider === "local" && models.selectedId === spec.id
        const previousActive = models.activeLocal
        let settingsCleared = false
        try {
          const downloaded = await listDownloadedLocalModels()
          const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id
          if (active) {
            await clearSelectedModel()
            settingsCleared = true
          }
          if (active || deletingLast) await models.llama.stop()
          await deleteLocalGguf(spec)
        } catch (error) {
          let failure = error
          if (settingsCleared) {
            try {
              await saveSelectedModel(catalogModelFromSpec(spec, previousActive?.contextLength))
              if (previousActive) await models.restorePrevious(previousActive)
            } catch (rollbackError) {
              failure = new AggregateError(
                [error, rollbackError],
                `${errorMessage(error)} The active local model could not be restored.`,
              )
            }
          }
          throw new Error(`Could not delete ${spec.displayName}: ${errorMessage(failure)}`)
        }
        if (active) models.clearActive()
        return { wasActive: active, remaining: await listDownloadedLocalModels() }
      })
      if (!deleted) throw new Error(SELECTION_CANCELLED)
      return deleted
    } finally {
      this.#deleting = false
    }
  }

  async shutdown() {
    this.artifacts.dispose()
    this.conversation.stop()
    this.models.cancelPrepare()
    this.models.cancelSelection()
    await Promise.allSettled([this.conversation.wait(), this.models.waitForSelection()])
    await this.sessions.releaseLock()
    await this.models.stop()
  }
}

const MAX_VISIBLE_SEGMENTS = 3

export function formatWorkspaceLabel(cwd: string, userHome = homedir()) {
  const absoluteCwd = resolve(cwd)
  const fromHome = relative(resolve(userHome), absoluteCwd)
  const inHome =
    fromHome === "" ||
    (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome))
  const root = inHome ? "~" : parse(absoluteCwd).root
  const parts = (inHome ? fromHome : relative(root, absoluteCwd)).split(sep).filter(Boolean)
  if (parts.length === 0) return root
  const visible = parts.length <= MAX_VISIBLE_SEGMENTS ? parts : ["…", ...parts.slice(-2)]
  return inHome ? `~${sep}${visible.join(sep)}` : `${root}${visible.join(sep)}`
}
