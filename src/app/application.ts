import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path"
import { requestContextEstimator } from "../core/compaction.js"
import { loadProjectContext } from "../core/context.js"
import { validateAttachments } from "../inference/attachments.js"
import { listHostedModels } from "../inference/client.js"
import { requireLocalContextLength } from "../inference/context-policy.js"
import { describeError } from "../inference/errors.js"
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
  type HostedPickerChoice,
  isSelectablePickerItem,
  isServerPickerChoice,
  type ModelPickerChoice,
  toLocalCatalogModel,
  toPairCatalogModel,
  toServerCatalogModel,
} from "../inference/picker-catalog.js"
import { hiddenModelKey } from "../inference/picker-filter.js"
import {
  baseFireworksModelId,
  findHostedModel,
  fireworksServingModel,
  isFastFireworksModel,
} from "../inference/serving-path.js"
import {
  type AttachmentContentPart,
  type CatalogModel,
  type ChatMessage,
  type ContextFile,
  type FireworksModel,
  HOSTED_PROVIDER_INFO,
  HOSTED_PROVIDERS,
  type HostedApiKeys,
  type HostedModel,
  type HostedProvider,
  isHostedModel,
  isHostedProvider,
  isServerCatalogModel,
  isServerProvider,
  type ModelProvider,
  type OutputCapabilities,
  SERVER_INFO,
  type ServerProvider,
  type SessionUsage,
  type UserChatMessage,
} from "../inference/types.js"
import { loadRoutines, ROUTINES_UNAVAILABLE } from "../local/routines.js"
import {
  clearSelectedModel,
  hostedApiKeys,
  type LocalSettings,
  loadLocalSettings,
  saveFastServingSelection,
  saveHiddenModels,
  saveHostedApiKey,
  saveLocalServers,
  saveLocalThinking,
  savePermissionMode,
  savePrimeTeamId,
  saveSelectedModel,
} from "../local/settings.js"
import { publishOmarchyUsage } from "../local/stats.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  loadProjectPermissionRules,
  type PermissionMode,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadSkillCatalog, type SkillCatalog, type SkillsSummary } from "../skills/catalog.js"
import type { SkillManager } from "../skills/manager.js"
import { sessionFile } from "../storage/session-files.js"
import { providerTools } from "../tools/index.js"
import { ParallelClient } from "../web/client.js"
import { ArtifactStore } from "./artifacts.js"
import {
  Conversation,
  type ConversationEvent,
  type PendingPermission,
  PermissionBroker,
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
  type ModelSelection,
  type ModelState,
  resolveHostedServing,
} from "./models.js"
import { Routines } from "./routines.js"
import { type OpenSession, SESSION_REASONS, SessionCoordinator } from "./sessions.js"
import { type SubagentStatus, SubagentTraces } from "./subagents.js"
import { type TranscriptChange, TranscriptStore } from "./transcript.js"

type ApplicationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
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

/** One open session runtime as a tab strip or picker lists it. */
export type RuntimeSummary = {
  runtime: number
  session: { id: string; title: string; dirName: string } | null
  /** The folder this session works in. */
  workspace: { label: string; path: string }
  focused: boolean
  busy: boolean
  unseen: boolean
  diffs: { added: number; removed: number }
  contextTokens: number
}

/** A connected server as adapters show it: the address and what was entered beside it. */
export type ServerStatus = {
  baseURL: string
  hasApiKey: boolean
  model?: string
  contextLength?: number
}

/**
 * The mutable application state outside the transcript, shared by every interface. Session
 * fields describe the focused runtime; `runtimes` lists every open one.
 */
export type AppStatus = {
  busy: boolean
  phase: TurnPhase
  /** Generation speed of the latest model request; null until the current turn streams. */
  speed: TurnSpeed | null
  /** The focused session's recorded usage; null without a session. */
  usage: SessionUsage | null
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
  /** The approval request at the head of the shared broker queue, from any runtime. */
  permission: PendingPermission | null
  /** Approval requests waiting behind `permission`. */
  permissionQueue: number
  localThinking: LocalThinkingState | null
  permissionMode: PermissionMode
  /** Fast serving for the selected hosted model: whether it has a fast path, and whether it is on. */
  fastServing: { available: boolean; enabled: boolean }
  hostedConfigured: Record<HostedProvider, boolean>
  /** Hosted models hidden from the picker, as `hiddenModelKey` strings. */
  hiddenModels: string[]
  /** The Prime Intellect team billed for inference, or null for the personal wallet. */
  primeTeamId: string | null
  pairEndpoints: PairEndpoints
  /** The connected user-managed servers; keys never leave the process. */
  servers: Partial<Record<ServerProvider, ServerStatus>>
  subagents: SubagentSummary[]
  runtimes: RuntimeSummary[]
  /** Busy runtimes other than the focused one. */
  working: number
}

type AppEventBody =
  | { type: "status" }
  | { type: "transcript"; change: TranscriptChange }
  | { type: "permission"; request: PendingPermission | null }
  | ConversationEvent

/**
 * Status-affecting changes carry no payload: adapters diff `status()`. Transcript edits, the
 * approval head, and conversation events carry theirs. Every event names the runtime it came
 * from: app-wide changes (model, focus) carry the focused runtime, an approval head its asker's.
 */
export type AppEvent = AppEventBody & { runtime: number }

/**
 * The outcome of a model transaction. A superseded or aborted request reports
 * SELECTION_SUPERSEDED or SELECTION_CANCELLED rather than a failure.
 */
export type SelectionResult = { ok: true } | { ok: false; reason: string }

export type SelectModelOptions = {
  signal?: AbortSignal
  /** The session to put on the model; the focused one by default. */
  runtime?: SessionRuntime
  /** The target's provider key, not yet saved (onboarding); kept once the selection commits. */
  hostedApiKey?: string
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
function hostedCatalogModel(choice: HostedPickerChoice): HostedModel {
  const { kind: _kind, available: _available, active: _active, status: _status, ...model } = choice
  return model
}

/** Picker rows are keyed the way the list keys them: servers and PAIR by selectionKey. */
function pickerKey(model: CatalogModel) {
  if (isServerProvider(model.provider)) return `${model.provider}:${model.id}`
  return model.provider === "pair" ? pairModelKey(model) : model.id
}

/**
 * One folder's loaded state, shared by every session in it: the folder, its AGENTS.md context,
 * the skills visible from it, and its project permission rules.
 */
export class Workspace {
  readonly label: string

  private constructor(
    readonly cwd: string,
    public projectContext: ContextFile[],
    public skills: SkillCatalog,
    readonly rules: PermissionRule[],
  ) {
    this.label = formatWorkspaceLabel(cwd)
  }

  static async load(cwd: string) {
    return new Workspace(
      cwd,
      loadProjectContext(cwd),
      await loadSkillCatalog(cwd),
      await loadProjectPermissionRules(cwd),
    )
  }
}

/**
 * One open session: its own transcript, delegated runs, artifacts, session file and lock, and
 * turn loop. Its id is the conversation's — the owner id at the inference gate and the permission
 * broker.
 */
export class SessionRuntime {
  /** The model this session runs on; a new runtime starts on the focused one's. */
  selection: ModelSelection | undefined
  /** An in-place open whose working folder is unknown or gone; prompts wait for a locate. */
  readOnly: { dirName: string; sessionId: string } | undefined
  /** Settled while not focused; cleared on focus. */
  unseen = false
  readonly #detach: () => void

  constructor(
    readonly workspace: Workspace,
    /** A routine's run approves its tools under this mode; other sessions follow the setting. */
    readonly permissionMode: PermissionMode | undefined,
    readonly models: ModelHost,
    selection: ModelSelection | undefined,
    readonly transcript: TranscriptStore,
    readonly subagents: SubagentTraces,
    readonly artifacts: ArtifactStore,
    readonly sessions: SessionCoordinator,
    readonly conversation: Conversation,
    attach: (runtime: SessionRuntime) => () => void,
  ) {
    this.selection = selection
    this.#detach = attach(this)
  }

  get id() {
    return this.conversation.id
  }

  get busy() {
    return this.conversation.busy
  }

  /** The gated client this session's requests go through; none until its model serves. */
  get client() {
    return this.models.clientFor(this.id, this.selection)
  }

  /** A live client is the ready state; without one, the host says why, and a failed start is a
   * failure even before any selection took. */
  get modelState(): ModelState {
    if (this.client) return "ready"
    if (this.models.state === "failed") return "failed"
    return this.selection ? this.models.state : "unconfigured"
  }

  get modelError() {
    return this.client ? undefined : this.models.error
  }

  /** Stops the turn, waits it out, and releases the session lock; the runtime is done after. */
  async dispose() {
    this.conversation.stop()
    await this.conversation.wait()
    this.#detach()
    this.artifacts.dispose()
    await this.sessions.releaseLock()
  }
}

export class Application {
  readonly outputCapabilities: OutputCapabilities
  readonly models: ModelHost
  /** The saved routines and their scheduler; undefined when routines.json does not parse. */
  routines: Routines | undefined
  /** Why routines are unavailable, for the places that would otherwise offer them. */
  routinesError: string | undefined
  /** The approval surface every runtime asks through; `status().permission` is its head. */
  readonly permissions = new PermissionBroker()
  readonly webClient = new ParallelClient()
  settings: LocalSettings
  permissionMode: PermissionMode
  /** The user's own rules from settings; each workspace adds its project's. */
  #settingsRules: PermissionRule[]
  /** Every folder a session has been opened in this process, loaded once. */
  readonly #workspaces = new Map<string, Promise<Workspace>>()
  readonly hostedApiKeys: HostedApiKeys
  pairEndpoints: PairEndpoints
  /**
   * An adapter's own reasons not to admit a prompt or drive the queue (shutting down, switching
   * workspaces, opening a session), checked before the model's.
   */
  extraGate: (() => string | undefined) | undefined
  readonly #listeners = new Set<(event: AppEvent) => void>()
  readonly #isExiting: () => boolean
  readonly #runtimes: SessionRuntime[] = []
  #focused!: SessionRuntime
  #debug = false
  /** A local-model deletion is in flight; other model transactions are refused until it settles. */
  #deleting = false
  /** Sessions whose own selection is in flight; their prompts wait for it to settle. */
  readonly #switching = new Set<SessionRuntime>()
  /** One catalog lookup at a time resolves an unknown image capability for the selected model. */
  #imageSupport: { modelId: string; promise: Promise<void> } | undefined

  static async create(options: ApplicationOptions = {}) {
    const workspace = await Workspace.load(resolve(options.cwd ?? process.cwd()))
    const settings = await loadLocalSettings({ env: options.env })
    const app = new Application(workspace, settings, options)
    app.routines = await loadRoutines().then(
      (routines) => new Routines(app, routines),
      (error) => {
        app.routinesError = `${ROUTINES_UNAVAILABLE} ${describeError(error)}`
        return undefined
      },
    )
    app.models.applySettings(settings)
    app.#focused.selection = app.models.savedSelection(settings)
    // A saved selection without a client still needs its server (local, oMLX) or its key.
    if (!app.#focused.client)
      app.models.setState(app.hasConfiguredSelection() ? "starting" : "unconfigured")
    void app.publishUsage()
    return app
  }

  /** Otis' entry in Omarchy's agents bar panel; best effort, from the sessions on disk. */
  publishUsage() {
    return publishOmarchyUsage(this.#focused.selection?.model.provider).catch(() => undefined)
  }

  private constructor(workspace: Workspace, settings: LocalSettings, options: ApplicationOptions) {
    this.#isExiting = options.isExiting ?? (() => false)
    this.#workspaces.set(workspace.cwd, Promise.resolve(workspace))
    this.outputCapabilities = options.outputCapabilities ?? {}
    this.settings = settings
    this.hostedApiKeys = hostedApiKeys(settings)
    this.pairEndpoints = { ...settings.pairEndpoints }
    this.permissionMode = settings.permissions?.defaultMode ?? DEFAULT_PERMISSION_MODE
    this.#settingsRules = [...(settings.permissions?.rules ?? [])]
    this.models = new ModelHost({ env: options.env })
    this.models.onLocal = (selection) => {
      for (const runtime of this.#runtimes)
        if (runtime.selection?.model.provider === "local")
          runtime.selection = selection
            ? { ...selection }
            : { ...runtime.selection, client: undefined }
    }
    this.models.subscribe(() => {
      this.#notify({ type: "status" })
      // Follow-ups parked by a model switch resume on the settled model, whether the switch
      // committed, failed, or was superseded.
      if (!this.models.selecting) for (const runtime of this.#runtimes) runtime.conversation.drain()
    })
    this.permissions.subscribe((request) =>
      this.#notify({ type: "permission", request }, request?.runtime),
    )
    this.#focused = this.#createRuntime(workspace)
    this.#runtimes.push(this.#focused)
  }

  /** The focused session's folder; the one an interface shows and acts in by default. */
  get cwd() {
    return this.#focused.workspace.cwd
  }

  get projectContext() {
    return this.#focused.workspace.projectContext
  }

  get skills() {
    return this.#focused.workspace.skills
  }

  /** The user's rules followed by the focused workspace's project rules. */
  get permissionRules(): PermissionRule[] {
    return [...this.#settingsRules, ...this.#focused.workspace.rules]
  }

  /** The loaded state of a folder, read once per process and shared by its sessions. */
  workspace(path: string): Promise<Workspace> {
    const cwd = resolve(path)
    let loading = this.#workspaces.get(cwd)
    if (!loading) {
      loading = Workspace.load(cwd)
      this.#workspaces.set(cwd, loading)
      loading.catch(() => this.#workspaces.delete(cwd))
    }
    return loading
  }

  /** A runtime with its own stores, coordinator, and turn loop, reporting events under its id. */
  #createRuntime(workspace: Workspace, permissionMode?: PermissionMode): SessionRuntime {
    const selection = this.#focused?.selection && { ...this.#focused.selection }
    const transcript = new TranscriptStore()
    const subagents = new SubagentTraces()
    const artifacts = new ArtifactStore(workspace.cwd)
    let runtime!: SessionRuntime
    const sessions = new SessionCoordinator({
      cwd: workspace.cwd,
      transcript,
      subagents,
      client: () => runtime.client,
      isBusy: () => runtime.busy,
      isExiting: this.#isExiting,
      onReset: () => {
        artifacts.clear()
        conversation.clearSpeed()
      },
      onReplay: (messages, activities, session) => {
        artifacts.restore(messages, activities, session.artifactDirectory)
        conversation.clearSpeed()
      },
    })
    const conversation = new Conversation({
      sessions,
      transcript,
      subagents,
      webClient: this.webClient,
      cwd: workspace.cwd,
      serving: () => {
        const client = runtime.client
        const model = runtime.selection?.model
        if (!client || !model) return undefined
        return {
          client,
          provider: model.provider,
          model: model.id,
          modelName: model.displayName,
          autoCompactAtTokens: this.models.autoCompactAtTokens(model),
        }
      },
      projectContext: () => workspace.projectContext,
      skills: () => workspace.skills,
      routines: () => this.routines ?? { error: this.routinesError ?? ROUTINES_UNAVAILABLE },
      permissionPolicy: () => this.createPermissionPolicy(workspace, permissionMode),
      broker: this.permissions,
      isExiting: this.#isExiting,
      outputCapabilities: this.outputCapabilities,
      artifacts,
      gate: () => this.admissionGate(runtime),
    })
    conversation.debug = this.#debug
    runtime = new SessionRuntime(
      workspace,
      permissionMode,
      this.models,
      selection,
      transcript,
      subagents,
      artifacts,
      sessions,
      conversation,
      (self) => {
        const unsubscribe = [
          sessions.subscribe(() => this.#notify({ type: "status" }, self.id)),
          transcript.subscribe((change) => this.#notify({ type: "transcript", change }, self.id)),
          conversation.subscribe((event) => {
            if (event.type === "settled") {
              if (self !== this.#focused) self.unseen = true
              void this.publishUsage()
            }
            this.#notify(event, self.id)
          }),
        ]
        return () => {
          for (const stop of unsubscribe) stop()
        }
      },
    )
    return runtime
  }

  /** The runtime whose session the interface shows; every session alias below reads it. */
  get focused() {
    return this.#focused
  }

  get runtimes(): readonly SessionRuntime[] {
    return this.#runtimes
  }

  /** Any runtime mid-turn; model and server transactions would cut every one of them off. */
  get anyBusy() {
    return this.#runtimes.some((runtime) => runtime.busy)
  }

  get transcript() {
    return this.#focused.transcript
  }

  get artifacts() {
    return this.#focused.artifacts
  }

  get subagents() {
    return this.#focused.subagents
  }

  get sessions() {
    return this.#focused.sessions
  }

  get conversation() {
    return this.#focused.conversation
  }

  /** Session-only debug mode for every runtime, open now or later; applies from the next turn. */
  get debug() {
    return this.#debug
  }

  set debug(enabled: boolean) {
    this.#debug = enabled
    for (const runtime of this.#runtimes) runtime.conversation.debug = enabled
  }

  /** Rereads the skills on disk for every open folder; conversations pick them up next turn. */
  async reloadSkills() {
    for (const loading of this.#workspaces.values()) {
      const workspace = await loading
      workspace.skills = await loadSkillCatalog(workspace.cwd)
    }
  }

  /** The skills reread from disk as the pickers list them, each with where it comes from. */
  async listSkills(manager: SkillManager): Promise<SkillsSummary> {
    await this.reloadSkills()
    const sources = await manager.list()
    const managed = new Map(
      sources.flatMap((source) => source.skills.map((skill) => [skill.name, source.id] as const)),
    )
    return {
      skills: this.skills.skills.map((skill) => {
        const collection = managed.get(skill.name)
        return {
          name: skill.name,
          description: skill.description,
          origin: collection
            ? { collection }
            : skill.bundled
              ? "bundled"
              : dirname(skill.root) === manager.activationDirectory
                ? "personal"
                : "project",
        }
      }),
      sources,
    }
  }

  /** The sessions open in this process; `shown` are on screen, the focused one alone by default. */
  openSessions(shown: readonly SessionRuntime[] = [this.#focused]): OpenSession[] {
    return this.#runtimes.flatMap((runtime) => {
      const { current, currentDirName } = runtime.sessions
      if (!current || !currentDirName) return []
      return [
        {
          id: current.id,
          dirName: currentDirName,
          shown: shown.includes(runtime),
          working: runtime.busy,
          unseen: runtime.unseen,
        },
      ]
    })
  }

  /**
   * Why a prompt cannot be admitted to a runtime right now. Model switching and prompt admission
   * are mutually exclusive: preparation may stop the server the prompt would run on, and the busy
   * window alone does not cover the asynchronous selection span.
   */
  admissionGate(runtime = this.#focused): string | undefined {
    const extra = this.extraGate?.()
    if (extra) return extra
    if (runtime.readOnly) return "Locate the working folder to continue this session."
    if (runtime.modelState === "starting") return MODEL_STARTING
    // A switch may stop the managed server or reconnect a user-managed one, and always changes
    // the session that asked for it; a hosted session with its client is otherwise unaffected.
    const hosted = isHostedProvider(runtime.selection?.model.provider)
    if (this.models.selecting && (!hosted || !runtime.client || this.#switching.has(runtime)))
      return MODEL_SWITCHING
    if (runtime.client) return undefined
    return runtime.modelError ?? NO_MODEL
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

  #notify(event: AppEventBody, runtime = this.#focused.id) {
    for (const listener of this.#listeners) listener({ ...event, runtime })
  }

  /**
   * Opens a session in this process: focuses the runtime that already has it, refuses one another
   * process holds, and otherwise loads it — into the focused runtime when that one is idle and in
   * the session's folder, else into a new runtime that takes focus. Never refused for being busy.
   * `cwd` names the session's folder when it is not the focused one.
   */
  async openSession(
    sessionId: string,
    storage?: { directory?: string; cwd?: string },
  ): Promise<"focused" | "opened" | "locked"> {
    const open = this.#runtimes.find((runtime) =>
      runtime.sessions.isCurrent(sessionId, storage?.directory),
    )
    if (open) {
      this.focus(open)
      return "focused"
    }
    const workspace = storage?.cwd ? await this.workspace(storage.cwd) : this.#focused.workspace
    const reuse = !this.#focused.busy && this.#focused.workspace === workspace
    const runtime = reuse ? this.#focused : this.#createRuntime(workspace)
    let result: "noop" | "loaded" | "locked" | undefined
    try {
      result = await runtime.sessions.select(sessionId, storage?.directory)
    } finally {
      if (result !== "loaded" && runtime !== this.#focused) await runtime.dispose()
    }
    if (result !== "loaded") return result === "locked" ? "locked" : "focused"
    runtime.readOnly = undefined
    if (runtime !== this.#focused) {
      this.#runtimes.push(runtime)
      this.focus(runtime)
    }
    return "opened"
  }

  /**
   * Opens a session in a runtime that does not take focus, for placing beside the focused one:
   * the runtime already holding it, else a new one. Refused sessions leave nothing behind.
   */
  async openBeside(sessionId: string): Promise<SessionRuntime | "locked" | undefined> {
    const open = this.#runtimes.find((runtime) => runtime.sessions.isCurrent(sessionId))
    if (open) return open
    // Opening creates what is missing; a session deleted since is not brought back empty.
    if (!(await stat(sessionFile({ cwd: this.cwd }, sessionId)).catch(() => undefined)))
      return undefined
    const runtime = this.#createRuntime(this.#focused.workspace)
    if ((await runtime.sessions.select(sessionId)) !== "loaded") {
      await runtime.dispose()
      return "locked"
    }
    this.#runtimes.push(runtime)
    this.#notify({ type: "status" })
    return runtime
  }

  /** A fresh session: the focused runtime resets in place when idle, else a new one takes focus. */
  openNew(): SessionRuntime {
    if (this.#focused.busy) {
      const runtime = this.addRuntime()
      this.focus(runtime)
      return runtime
    }
    this.#focused.sessions.startNew()
    this.#focused.readOnly = undefined
    return this.#focused
  }

  /**
   * A fresh, unfocused runtime in a folder (the focused one's by default); the caller
   * places it.
   */
  addRuntime(workspace = this.#focused.workspace, permissionMode?: PermissionMode): SessionRuntime {
    const runtime = this.#createRuntime(workspace, permissionMode)
    this.#runtimes.push(runtime)
    return runtime
  }

  /**
   * A fresh session in a folder: the focused runtime resets in place when it is idle and already
   * there, else a new runtime in that folder takes focus. The caller decides what becomes of the
   * runtime it left.
   */
  async openFolder(path: string): Promise<SessionRuntime> {
    const workspace = await this.workspace(path)
    if (workspace === this.#focused.workspace) return this.openNew()
    const runtime = this.addRuntime(workspace)
    this.focus(runtime)
    return runtime
  }

  /** Shows a runtime: its transcript replaces the view and its completion is seen. */
  focus(runtime: SessionRuntime) {
    runtime.unseen = false
    if (runtime === this.#focused) return
    this.#focused = runtime
    this.#notify({ type: "transcript", change: { op: "reset" } }, runtime.id)
    this.#notify({ type: "status" }, runtime.id)
  }

  /** A runtime the interface no longer shows, with no session and no work, has nothing to keep. */
  closeIfEmpty(runtime: SessionRuntime) {
    if (!runtime.busy && !runtime.sessions.current) void this.closeRuntime(runtime)
  }

  /** Refused while the runtime is mid-turn. Closing the last runtime leaves a fresh empty one. */
  async closeRuntime(runtime: SessionRuntime): Promise<"closed" | "working"> {
    if (runtime.busy) return "working"
    const index = this.#runtimes.indexOf(runtime)
    if (index < 0) throw new Error("That session runtime is not open.")
    this.#runtimes.splice(index, 1)
    if (this.#runtimes.length === 0) this.#runtimes.push(this.#createRuntime(runtime.workspace))
    if (runtime === this.#focused)
      this.focus(this.#runtimes[Math.min(index, this.#runtimes.length - 1)])
    else this.#notify({ type: "status" })
    await runtime.dispose()
    return "closed"
  }

  /**
   * Deletes a stored session. Refused while a runtime holding it is mid-turn; an idle runtime
   * holding it closes first (the focused one resets in place, as a fresh session).
   */
  async deleteSession(
    sessionId: string,
    storage?: { directory: string },
  ): Promise<"deleted" | "working" | "locked"> {
    const open = this.#runtimes.find((runtime) =>
      runtime.sessions.isCurrent(sessionId, storage?.directory),
    )
    if (open?.busy) return "working"
    if (open && open !== this.#focused) await this.closeRuntime(open)
    const runtime = this.#focused
    const result = await runtime.sessions.delete(sessionId, storage)
    if (result === "busy") return "working"
    if (result === "deleted" && !runtime.sessions.current) runtime.readOnly = undefined
    return result
  }

  /** Compacts a runtime's context; returns the reason when it is mid-turn. */
  async compact(instructions?: string, runtime = this.#focused): Promise<string | undefined> {
    if (runtime.busy) return SESSION_REASONS.working
    await runtime.conversation.compact(instructions, this.contextEstimator(runtime))
    return undefined
  }

  status(): AppStatus {
    const { models, sessions, conversation } = this
    const selection = this.#focused.selection
    const model = selection?.model
    const fastServing = { available: false, enabled: false }
    if (model?.provider === "fireworks") {
      fastServing.enabled = isFastFireworksModel(model.id)
      fastServing.available =
        fastServing.enabled ||
        model.fastId !== undefined ||
        this.settings.fastServingModels?.includes(baseFireworksModelId(model.id)) === true
    }
    return {
      busy: conversation.busy,
      phase: conversation.phase,
      speed: conversation.speed,
      usage: sessions.current?.usage() ?? null,
      model: model
        ? {
            id: model.id,
            provider: model.provider,
            supportsImageInput: selection?.supportsImageInput === true,
            displayName: model.displayName,
          }
        : null,
      modelState: this.#focused.modelState,
      modelError: this.#focused.modelError,
      modelLoad: models.load ?? null,
      session: sessions.current ? { id: sessions.current.id, title: sessions.activeLabel() } : null,
      diffs: sessions.diffs,
      contextTokens: this.contextTokens(),
      contextLimit: models.autoCompactAtTokens(model),
      permission: this.permissions.current,
      permissionQueue: Math.max(0, this.permissions.pending.length - 1),
      localThinking: models.thinkingState(model),
      permissionMode: this.permissionMode,
      fastServing,
      hostedConfigured: this.hostedConfigured(),
      hiddenModels: [...(this.settings.hiddenModels ?? [])],
      primeTeamId: models.primeTeamId ?? null,
      pairEndpoints: { ...this.pairEndpoints },
      servers: Object.fromEntries(
        Object.entries(models.servers).map(([provider, { apiKey, ...server }]) => [
          provider,
          { ...server, hasApiKey: Boolean(apiKey) },
        ]),
      ),
      subagents: this.subagents.all.map((trace) => ({
        toolCallId: trace.toolCallId,
        title: trace.title,
        status: trace.status,
        ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
        tools: trace.transcript.entries.filter((entry) => entry.kind === "tool").length,
      })),
      runtimes: this.#runtimes.map((runtime) => {
        const { current, currentDirName } = runtime.sessions
        return {
          runtime: runtime.id,
          session:
            current && currentDirName
              ? { id: current.id, title: runtime.sessions.activeLabel(), dirName: currentDirName }
              : null,
          workspace: { label: runtime.workspace.label, path: runtime.workspace.cwd },
          focused: runtime === this.#focused,
          busy: runtime.busy,
          unseen: runtime.unseen,
          diffs: runtime.sessions.diffs,
          contextTokens: this.contextTokens(undefined, runtime),
        }
      }),
      working: this.#runtimes.filter((runtime) => runtime !== this.#focused && runtime.busy).length,
    }
  }

  /** Thinking effort is per local model, so every session on it changes together. */
  async setLocalThinking(model: string, level: string) {
    const local = this.#runtimes.filter((runtime) => runtime.selection?.model.provider === "local")
    if (local.some((runtime) => runtime.busy))
      throw new Error("Finish the current work before changing thinking effort.")
    if (!local.some((runtime) => runtime.selection?.model.id === model))
      throw new Error("The selected local model has changed.")
    const preferences = await saveLocalThinking(model, level)
    this.settings.localThinking = preferences
    this.models.localThinking = preferences
    for (const runtime of local) runtime.transcript.invalidateContext()
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

  createPermissionPolicy(workspace = this.#focused.workspace, mode = this.permissionMode) {
    return createPermissionPolicy({
      cwd: workspace.cwd,
      mode,
      rules: [...this.#settingsRules, ...workspace.rules],
    })
  }

  contextEstimator(runtime = this.#focused) {
    const { projectContext, skills } = runtime.workspace
    const tools = providerTools(runtime.selection?.model.provider ?? "fireworks").filter(
      (tool) => tool.name !== "skill" || skills.skills.length > 0,
    )
    return requestContextEstimator({
      tools,
      projectContext,
      skills: tools.some((tool) => tool.name === "skill") ? skills.skills : [],
      outputCapabilities: this.outputCapabilities,
    })
  }

  contextTokens(pendingInput?: UserChatMessage, runtime = this.#focused) {
    const estimate = this.contextEstimator(runtime)
    const { transcript } = runtime
    const tokens =
      transcript.contextTokens(runtime.selection?.client) ?? estimate(transcript.history)
    return pendingInput ? tokens + estimate([pendingInput]) - estimate([]) : tokens
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
   * serving entry persisted. Server-discovered models (PAIR, user-managed) answer from their
   * discovery.
   */
  async ensureImageSupport(signal?: AbortSignal): Promise<void> {
    const runtime = this.#focused
    const selection = runtime.selection
    if (!selection) throw new Error("Select a model first.")
    if (selection.supportsImageInput === true) return
    const { model } = selection
    const unsupported = () =>
      new Error(`${model.displayName} does not support image input. Choose a vision model.`)
    if (selection.supportsImageInput === false) throw unsupported()
    const apiKey = isHostedModel(model) ? this.hostedApiKeys[model.provider] : undefined
    if (!isHostedModel(model) || !apiKey) {
      selection.supportsImageInput =
        model.provider === "local" && findLocalModel(model.id)?.supportsImageInput === true
      this.#notify({ type: "status" })
      if (!selection.supportsImageInput) throw unsupported()
      return
    }
    if (this.#imageSupport?.modelId !== model.id) {
      const promise = (async () => {
        const { serving } = await resolveHostedServing(model.provider, apiKey, model.id, {
          fast: isFastFireworksModel(model.id),
          signal,
        })
        if (runtime.selection !== selection)
          throw new Error("The selected model changed while checking image support.")
        selection.supportsImageInput = serving.supportsImageInput
        await saveSelectedModel(serving)
        this.#notify({ type: "status" })
      })().finally(() => {
        if (this.#imageSupport?.promise === promise) this.#imageSupport = undefined
      })
      this.#imageSupport = { modelId: model.id, promise }
    }
    await this.#imageSupport.promise
    if (!selection.supportsImageInput) throw unsupported()
  }

  hasConfiguredSelection() {
    const model = this.#focused.selection?.model
    return Boolean(
      model &&
        ((isHostedModel(model) && this.hostedApiKeys[model.provider]) ||
          model.provider === "local" ||
          (isServerProvider(model.provider) && this.models.servers[model.provider]) ||
          (model.provider === "pair" && pairEndpointForEngine(this.pairEndpoints, model.engine))),
    )
  }

  /** The focused session's model, for adapters that show one. */
  get selection() {
    return this.#focused.selection
  }

  /** Connects a model outright for the focused session, outside the selection queue. */
  async connectModel(options: Parameters<ModelHost["connect"]>[0]) {
    const selection = await this.models.connect(options)
    this.#focused.selection = selection
    return selection
  }

  /**
   * Probes and persists local servers, refreshing the active PAIR or server client onto the new
   * endpoints. A selection whose server no longer answers is invalidated and reported as failed.
   */
  async connectLocalServers(input: LocalServerInputs, options: LocalServerDiscoveryOptions = {}) {
    if (this.anyBusy) throw new Error("Wait for the current turn before changing local servers.")
    try {
      return await this.#connectLocalServers(input, options)
    } catch (error) {
      if (this.#runtimes.some((runtime) => runtime.selection && !runtime.client))
        this.models.setState("failed", describeError(error))
      throw error
    }
  }

  async #connectLocalServers(input: LocalServerInputs, options: LocalServerDiscoveryOptions) {
    const models = this.models
    const connection = await models.enqueueSelection(async (signal) => {
      const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal
      const servers = await prepareLocalServers(input, models.servers, {
        ...options,
        signal: combined,
      })
      combined.throwIfAborted()
      // The sessions on a user-managed server follow its refreshed endpoints and models.
      const served = this.#runtimes.flatMap((runtime) => {
        const selection = runtime.selection
        const provider = selection?.model.provider
        return selection && (provider === "pair" || isServerProvider(provider))
          ? [{ runtime, selection }]
          : []
      })
      const refreshedServerModel = (model: CatalogModel) =>
        isServerCatalogModel(model)
          ? servers.serverModels[model.provider]?.find((entry) => entry.id === model.id)
          : undefined
      for (const { runtime, selection } of served) {
        const refreshed = refreshedServerModel(selection.model)
        if (!refreshed) continue
        try {
          requireLocalContextLength(refreshed.contextLength, SERVER_INFO[refreshed.provider].name)
        } catch (error) {
          // A refreshed limit invalidates the existing client only when it describes the same
          // server.
          if (refreshed.baseURL === models.servers[refreshed.provider]?.baseURL) {
            runtime.selection = { ...selection, client: undefined }
            runtime.transcript.invalidateContext()
          }
          throw error
        }
      }
      await saveLocalServers({ pairEndpoints: servers.pairEndpoints, ...servers.servers })
      this.pairEndpoints = servers.pairEndpoints
      models.servers = servers.servers
      for (const { runtime, selection } of served) {
        const { model } = selection
        const refreshed =
          model.provider === "pair"
            ? servers.pairModels.find(
                (entry) => entry.id === model.id && entry.engine === model.engine,
              )
            : refreshedServerModel(model)
        const client =
          refreshed?.provider === "pair"
            ? createPairClient({
                baseURL: refreshed.baseURL,
                model: model.id,
                engine: refreshed.engine,
              })
            : refreshed
              ? models.serverClient(refreshed.provider, model.id, refreshed.baseURL)
              : undefined
        runtime.selection = {
          model: refreshed ?? model,
          supportsImageInput: refreshed?.supportsImageInput ?? selection.supportsImageInput,
          client,
        }
      }
      if (served.some(({ runtime }) => !runtime.client)) {
        models.setState(
          "failed",
          "The local model server for the selected model is no longer available. Reconnect or choose another model.",
        )
      }
      for (const runtime of this.#runtimes) runtime.transcript.invalidateContext()
      return servers
    })
    if (!connection) throw new Error("The connection was cancelled.")
    return connection
  }

  /**
   * Activates the saved selection through the selection queue: a model picked while the saved one
   * is still loading supersedes startup, so its late commit can never reactivate the old model
   * over the new one. Fireworks and PAIR clients already exist from `savedSelection`; a
   * saved local model still needs its managed llama-server started before any conversation can
   * run, and a saved oMLX model its server reached. Throws with the serving error when startup
   * fails and marks the host failed. Once startup is over, however it went, the host no longer
   * reads as starting; a failure keeps its message. The previous selection is left untouched.
   */
  async startSavedSelection(
    options: { signal?: AbortSignal; isExiting?: () => boolean } = {},
  ): Promise<"ready" | "unconfigured" | "superseded"> {
    const models = this.models
    const runtime = this.#focused
    try {
      if (runtime.client) return "ready"
      if (!runtime.selection) return "unconfigured"
      const result = await models.enqueueSelection(async (queued) => {
        const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
        const superseded = () => signal.aborted || options.isExiting?.() === true
        let result: "ready" | "unconfigured"
        try {
          result = await this.#startSavedSelection(runtime, signal, options.isExiting)
        } catch (error) {
          if (queued.aborted) return "superseded" as const
          if (superseded() || isAbortError(error)) throw error
          models.setLoad(undefined)
          models.setState("failed", describeError(error))
          throw error
        }
        if (!superseded()) models.setLoad(undefined)
        return result
      })
      return result ?? "superseded"
    } finally {
      if (models.state === "starting") models.setState("unconfigured")
    }
  }

  async #startSavedSelection(
    runtime: SessionRuntime,
    signal: AbortSignal,
    isExiting?: () => boolean,
  ): Promise<"ready" | "unconfigured"> {
    const models = this.models
    if (runtime.client) return "ready"
    const model = runtime.selection?.model
    if (!model) return "unconfigured"
    if (isServerCatalogModel(model)) {
      runtime.selection = await models.connect({
        provider: model.provider,
        modelId: model.id,
        signal,
      })
      return "ready"
    }
    if (model.provider !== "local") return "unconfigured"
    const prepared = await models.prepare(model, {
      hostedApiKeys: this.hostedApiKeys,
      signal,
      isExiting,
      onLocalProgress: (progress) => {
        models.setLoad({
          modelId: model.id,
          status: { label: formatLocalLoadStatus(progress), kind: "progress" },
        })
      },
    })
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
    const runtime = options.runtime ?? this.#focused
    const refusal = this.#switchRefusal(runtime, target.provider)
    if (refusal) return refusal
    const models = this.models
    const choice = "kind" in target ? target : undefined
    if (choice && !isSelectablePickerItem(choice)) {
      const label = "availabilityLabel" in choice ? choice.availabilityLabel : undefined
      return { ok: false, reason: label ?? "This model is not available on this machine." }
    }
    this.#switching.add(runtime)
    const selection = await models
      .enqueueSelection(async (queued): Promise<SelectionResult> => {
        const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
        if (signal.aborted) return SUPERSEDED
        const current = runtime.selection?.model
        const active = choice
          ? choice.active
          : current?.id === target.id && current.provider === target.provider
        // A managed server that died since it was ready must be restarted, not shortcut.
        const serving = target.provider !== "local" || models.llama.alive
        if (active && runtime.client && serving && !isServerProvider(target.provider))
          return { ok: true }
        // Defense in depth: no session a switch affects can start a turn while one is queued, so
        // running work here means a turn outlived the entry check.
        const refusal = this.#switchRefusal(runtime, target.provider)
        if (refusal) return refusal
        const selected: CatalogModel = !choice
          ? target
          : choice.provider === "local"
            ? toLocalCatalogModel(choice)
            : choice.provider === "pair"
              ? toPairCatalogModel(choice)
              : isServerPickerChoice(choice)
                ? toServerCatalogModel(choice)
                : fireworksServingModel(
                    hostedCatalogModel(choice),
                    this.fastServingEnabled(choice.id),
                  )
        const unsavedKey =
          options.hostedApiKey && isHostedModel(selected)
            ? { [selected.provider]: options.hostedApiKey }
            : {}
        try {
          runtime.selection = await models.persistSelection(selected, {
            signal,
            hostedApiKeys: { ...this.hostedApiKeys, ...unsavedKey },
            keepLocal: this.#localElsewhere(runtime),
            persist: options.persist ?? ((serving) => saveSelectedModel(serving)),
            loadKey: pickerKey(selected),
          })
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return CANCELLED
          return { ok: false, reason: describeError(error) }
        }
        Object.assign(this.hostedApiKeys, unsavedKey)
        runtime.conversation.clearSpeed()
        this.#notify({ type: "status" })
        return { ok: true }
      })
      .finally(() => this.#switching.delete(runtime))
    return selection ?? SUPERSEDED
  }

  /** Sessions other than `runtime` that run on the managed server. */
  #localElsewhere(runtime: SessionRuntime) {
    return this.#runtimes.some(
      (other) => other !== runtime && other.selection?.model.provider === "local",
    )
  }

  /**
   * A switch is refused while its session works, and a switch of the managed server while any
   * session on it works, since the server restart would cut those turns off.
   */
  #switchRefusal(runtime: SessionRuntime, provider: ModelProvider): SelectionResult | undefined {
    const restartsServer =
      provider === "local" ||
      (runtime.selection?.model.provider === "local" && !this.#localElsewhere(runtime))
    const affected = restartsServer
      ? this.#runtimes.filter(
          (other) => other === runtime || other.selection?.model.provider === "local",
        )
      : [runtime]
    if (this.#deleting || affected.some((other) => other.busy))
      return { ok: false, reason: "Finish the current work before switching models." }
    return undefined
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
    options: { catalog?: readonly HostedModel[]; signal?: AbortSignal } = {},
  ): Promise<SelectionResult> {
    const runtime = this.#focused
    if (this.#deleting || runtime.busy)
      return { ok: false, reason: "Finish the current work before changing Fast serving." }
    const models = this.models
    if (runtime.selection?.model.provider !== "fireworks")
      return { ok: false, reason: NO_FAST_SERVING }
    this.#switching.add(runtime)
    const selection = await models
      .enqueueSelection(async (queued): Promise<SelectionResult> => {
        const signal = options.signal ? AbortSignal.any([queued, options.signal]) : queued
        const current = runtime.selection?.model
        const apiKey = this.hostedApiKeys.fireworks
        if (current?.provider !== "fireworks") return { ok: false, reason: NO_FAST_SERVING }
        const selectedId = current.id
        if (isFastFireworksModel(selectedId) === fast) return { ok: true }
        if (signal.aborted) return SUPERSEDED
        let catalog = options.catalog
        try {
          if (!catalog?.length) {
            if (!apiKey) return { ok: false, reason: NO_FAST_SERVING }
            catalog = await listHostedModels("fireworks", apiKey, { signal })
          }
        } catch (error) {
          return { ok: false, reason: describeError(error) }
        }
        const model = findHostedModel(catalog, selectedId)
        if (!model?.fastId) return { ok: false, reason: NO_FAST_SERVING }
        const serving = fireworksServingModel(model, fast)
        try {
          runtime.selection = await models.persistSelection(serving, {
            signal,
            hostedApiKeys: this.hostedApiKeys,
            keepLocal: this.#localElsewhere(runtime),
            persist: (saved) => saveFastServingSelection(saved as FireworksModel, fast),
          })
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return CANCELLED
          return { ok: false, reason: describeError(error) }
        }
        const enabled = new Set(this.settings.fastServingModels ?? [])
        if (fast) enabled.add(model.id)
        else enabled.delete(model.id)
        this.settings.fastServingModels = [...enabled].sort()
        runtime.conversation.clearSpeed()
        this.#notify({ type: "status" })
        return { ok: true }
      })
      .finally(() => this.#switching.delete(runtime))
    return selection ?? SUPERSEDED
  }

  /** Hides a hosted model from the picker, or shows it again; the active model stays listed. */
  async setModelHidden(provider: HostedProvider, id: string, hidden: boolean) {
    const key = hiddenModelKey(provider, id)
    const hiddenModels = new Set(this.settings.hiddenModels ?? [])
    if (hidden) hiddenModels.add(key)
    else hiddenModels.delete(key)
    const next = [...hiddenModels]
    this.settings.hiddenModels = next.length ? next : undefined
    await saveHiddenModels(next)
    this.#notify({ type: "status" })
  }

  /** Bills Prime Intellect requests to `teamId`'s wallet (blank: the personal one) from now on. */
  async setPrimeTeamId(teamId: string) {
    const team = teamId.trim() || undefined
    await savePrimeTeamId(team)
    this.models.primeTeamId = team
    const apiKey = this.hostedApiKeys.primeintellect
    if (apiKey) this.#rebuildHostedClients("primeintellect", apiKey)
    this.#notify({ type: "status" })
  }

  /** Points every session on `provider` at a client built from the current key and team. */
  #rebuildHostedClients(provider: HostedProvider, apiKey: string) {
    for (const runtime of this.#runtimes) {
      const selection = runtime.selection
      if (selection?.model.provider === provider)
        runtime.selection = {
          ...selection,
          client: this.models.hostedClient(provider, apiKey, selection.model.id),
        }
    }
  }

  /** Which hosted providers have a key. */
  hostedConfigured(): Record<HostedProvider, boolean> {
    const configured = {} as Record<HostedProvider, boolean>
    for (const provider of HOSTED_PROVIDERS)
      configured[provider] = Boolean(this.hostedApiKeys[provider])
    return configured
  }

  /**
   * Validates a hosted provider's API key against its catalog, then persists and activates it: a
   * saved model of that provider waiting on a key becomes chat-ready the moment the key lands.
   * Returns the verified catalog. `list` is the desktop's catalog seam.
   */
  async setHostedApiKey(
    provider: HostedProvider,
    apiKey: string,
    options: { signal?: AbortSignal; list?: typeof listHostedModels } = {},
  ): Promise<HostedModel[]> {
    const key = apiKey.trim()
    if (!key) throw new Error(`${HOSTED_PROVIDER_INFO[provider].name} API key is required.`)
    const list = options.list ?? listHostedModels
    const catalog = await list(provider, key, { signal: options.signal })
    options.signal?.throwIfAborted()
    if (catalog.length === 0) throw new Error(NO_TOOL_MODELS)
    await saveHostedApiKey(provider, key)
    this.hostedApiKeys[provider] = key
    this.#rebuildHostedClients(provider, key)
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
    if (this.#deleting || this.anyBusy || models.selecting)
      throw new Error("Finish the current work before deleting a model.")
    const spec = findLocalModel(modelId)
    if (!spec) throw new Error("That model is not in the local catalog.")
    this.#deleting = true
    try {
      const deleted = await models.enqueueSelection(async () => {
        const users = this.#runtimes.filter(
          (runtime) =>
            runtime.selection?.model.provider === "local" && runtime.selection.model.id === spec.id,
        )
        const active = users.length > 0
        const previousActive = models.activeLocal
        let settingsCleared = false
        try {
          const downloaded = await listDownloadedLocalModels()
          const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id
          if ((await loadLocalSettings()).model === spec.id) {
            await clearSelectedModel()
            settingsCleared = true
          }
          if (active || deletingLast) await models.stopLocal()
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
                `${describeError(error)} The active local model could not be restored.`,
              )
            }
          }
          throw new Error(`Could not delete ${spec.displayName}: ${describeError(failure)}`)
        }
        for (const runtime of users) runtime.selection = undefined
        if (active) {
          models.cancelPrepare()
          models.setState("unconfigured")
        }
        return { wasActive: active, remaining: await listDownloadedLocalModels() }
      })
      if (!deleted) throw new Error(SELECTION_CANCELLED)
      return deleted
    } finally {
      this.#deleting = false
    }
  }

  /** Disposes every runtime (turns stopped, locks released), then stops the models. */
  async shutdown() {
    for (const runtime of this.#runtimes) runtime.conversation.stop()
    for (const { id } of this.permissions.pending) this.permissions.respond(id, false)
    this.models.cancelPrepare()
    this.models.cancelSelection()
    await Promise.allSettled([
      ...this.#runtimes.map((runtime) => runtime.dispose()),
      this.models.waitForSelection(),
    ])
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
