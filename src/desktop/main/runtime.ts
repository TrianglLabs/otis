import { stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Application } from "../../app/application.js"
import type { ConversationHooks, ConversationTurnResult, QueuedPrompt } from "../../app/conversation.js"
import type { GlobalSessionPickerItem } from "../../app/global-sessions.js"
import { listGlobalSessionPickerItems, searchGlobalSessionPickerItems } from "../../app/global-sessions.js"
import type { TranscriptChange, TranscriptEntry } from "../../app/transcript.js"
import { formatWorkspaceLabel } from "../../app/workspace-label.js"
import { autoCompactThreshold } from "../../core/compaction.js"
import { listToolCapableModels } from "../../inference/catalog.js"
import { FireworksClient } from "../../inference/client.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../../inference/gguf-cache.js"
import { formatLocalLoadStatus } from "../../inference/llama-runtime.js"
import { catalogModelFromSpec, findLocalModel, localModelWeightBytes } from "../../inference/local-catalog.js"
import { formatMemoryLabel } from "../../inference/local-fit.js"
import {
  discoverPairModels,
  normalizePairEndpoints,
  PairClient,
  type PairEndpoints,
  pairEndpointForEngine,
} from "../../inference/pair.js"
import {
  type FireworksPickerChoice,
  isSelectablePickerItem,
  listModelPickerItems,
  type ModelPickerChoice,
  type ModelPickerItem,
  type ModelPickerStatus,
  toLocalCatalogModel,
  toPairCatalogModel,
} from "../../inference/picker-catalog.js"
import { baseFireworksModelId, fireworksServingModel, isFastFireworksModel } from "../../inference/serving-path.js"
import type { CatalogModel, PairCatalogModel, UserChatMessage } from "../../inference/types.js"
import {
  clearSelectedModel,
  isThemeName,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveLastWorkspace,
  savePairEndpoints,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
} from "../../local/settings.js"
import { calculateLocalStats } from "../../local/stats.js"
import type { PermissionRequest } from "../../permissions/policy.js"
import {
  defaultSessionDirectory,
  readWorkspacePath,
  registerWorkspacePath,
  sessionFile,
  sessionRootDirectory,
} from "../../storage/index.js"
import { describeToolCall } from "../../tools/activity.js"
import type {
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  DownloadedLocalModel,
  ModelSelectResult,
  ModelState,
  PendingPermission,
  SendPromptResult,
  SessionOpResult,
  TranscriptPatchOp,
  TurnPhase,
} from "../contracts.js"

export type DesktopRuntimeOptions = {
  cwd: string
  version: string
  platform: NodeJS.Platform
  /** Delivers the ordered event stream to the renderer. */
  send: (event: DesktopEvent) => void
  /** Test seam for the picker catalog; production uses the real implementations. */
  listPickerItems?: typeof listModelPickerItems
  discoverPair?: typeof discoverPairModels
  /** Test seam for verifying a Fireworks key against the hosted catalog. */
  listToolCapableModels?: typeof listToolCapableModels
  /** Quits and installs the downloaded update; provided by the main process once a release is ready. */
  installUpdate?: () => Promise<void>
}

/** Maximum prompt size accepted from the renderer, matching what a session file can reasonably hold. */
const MAX_PROMPT_CHARS = 200_000

/** Streaming changes are batched so a fast token stream does not flood the IPC channel. */
const FLUSH_INTERVAL_MS = 32

/**
 * Owns the shared Application for one workspace and exposes explicit operations to the GUI. Electron-free so the
 * whole command path is testable; window and IPC wiring live in window.ts and ipc.ts.
 */
export class DesktopRuntime {
  #app: Application
  #unsubscribeTranscript: () => void
  #revision = 0
  #permissionSeq = 0
  #pending: { request: PendingPermission; resolve: (allow: boolean) => void } | undefined
  #phase: TurnPhase = "idle"
  #modelState: ModelState = "unconfigured"
  #modelError: string | undefined
  /** In-flight selectModel requests; prompt admission is rejected while any are open. */
  #selecting = 0
  /** A session open is in flight; prompts are rejected until its workspace state settles. */
  #sessionSelecting = 0
  /** A locate is completing; session changes are refused so recovery can't attach to the wrong session. */
  #locating = false
  /** The most recent picker listing; feeds fast-serving availability without a fetch per status. */
  #lastPickerItems: ModelPickerItem[] | undefined
  /** Session-only debug mode, mirroring the TUI's /debug toggle. */
  #debug = false
  /** A workspace switch in flight; switches and conflicting session operations are refused until it settles. */
  #switching = false
  /** Session opened in place whose working folder is unknown or gone; agent work is blocked until located. */
  #pendingWorkspace: { dirName: string; sessionId: string } | undefined
  /** Global session listing is disk-heavy; recomputed only when sessions change, not on streaming flushes. */
  #sessionsCache: GlobalSessionPickerItem[] | undefined
  /** A local-model deletion is in flight; model switches are rejected until its cleanup settles. */
  #deleting = false
  #modelLoad: { modelId: string; status: ModelPickerStatus } | undefined
  #stats: DesktopStatus["stats"]
  #update: DesktopStatus["update"]
  #queuedChanges: TranscriptChange[] = []
  #stateDirty = false
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #flushing: Promise<void> | undefined
  #draining = false
  #disposed = false
  /** Set when the renderer process died; queue draining is suspended until the user sends another prompt. */
  #rendererGone = false

  private constructor(
    app: Application,
    private readonly options: DesktopRuntimeOptions,
  ) {
    this.#app = app
    this.#unsubscribeTranscript = app.transcript.subscribe((change) => this.#onTranscriptChange(change))
    this.#modelState = app.models.client ? "ready" : app.hasConfiguredSelection() ? "starting" : "unconfigured"
  }

  static async create(options: DesktopRuntimeOptions) {
    const app = await Application.create({ cwd: options.cwd })
    return DesktopRuntime.forApplication(app, options)
  }

  /**
   * Builds a runtime around an existing application and starts its saved selection. A saved local model needs its
   * managed server started before any prompt can run, exactly as the TUI does at launch; Fireworks and PAIR
   * selections already have their client from applySavedSelection. This is the test seam for DesktopRuntime.
   */
  static forApplication(app: Application, options: DesktopRuntimeOptions) {
    const runtime = new DesktopRuntime(app, options)
    void runtime.#startSavedSelection()
    void runtime.#refreshStats()
    return runtime
  }

  async snapshot(): Promise<DesktopSnapshot> {
    return {
      platform: this.options.platform,
      version: this.options.version,
      entries: [...this.app.transcript.entries],
      revision: this.#revision,
      ...(await this.#status()),
    }
  }

  async sendPrompt(text: string): Promise<SendPromptResult> {
    // Once shutdown starts (update install), the session lock is released and no renderer receives updates.
    if (this.#disposed) return { accepted: false, reason: "Otis is restarting to finish an update." }
    if (this.#switching) return { accepted: false, reason: "Switching workspaces — try again in a moment." }
    if (this.#pendingWorkspace) {
      return { accepted: false, reason: "Locate the working folder to continue this session." }
    }
    // A foreign session's read-only restriction is set after its async open; prompts must not slip through first.
    if (this.#sessionSelecting > 0) return { accepted: false, reason: "Opening the session — try again in a moment." }
    // A live renderer sending a prompt un-gates the queue after a renderer crash; queued work never resumes on its own.
    this.#rendererGone = false
    if (typeof text !== "string" || !text.trim()) return { accepted: false, reason: "The prompt is empty." }
    if (text.length > MAX_PROMPT_CHARS) return { accepted: false, reason: "The prompt is too long." }
    // Model switching and prompt admission are mutually exclusive: preparation may stop the server this prompt
    // would run on, and the busy window alone does not cover the asynchronous selection span.
    if (this.#selecting > 0) {
      return { accepted: false, reason: "A model switch is in progress. Try again in a moment." }
    }
    if (!this.app.models.client) {
      return {
        accepted: false,
        reason:
          this.#modelState === "starting"
            ? "The model is still starting. Try again in a moment."
            : (this.#modelError ?? "No model is configured. Set up inference with the Otis CLI first."),
      }
    }

    const message: UserChatMessage = { role: "user", content: text }
    const { conversation } = this.app
    if (conversation.busy || this.#draining) {
      // steer() and queue() admit the prompt to the session before returning, so an accepted result here means the
      // follow-up is durably recorded. A rejection means nothing was saved and the draft must be kept.
      try {
        const delivery = await conversation.steer(message, () => {})
        if (delivery === "queued") this.#ensureDrain()
        this.#markStateDirty()
        return { accepted: true, delivery }
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    // Queued follow-ups waiting without a driver (e.g. suspended by a renderer crash) run first: admit the new
    // prompt behind them and restart the driver, preserving send order. The queue is only consumed after the new
    // admission succeeds — a failed admission leaves the backlog intact for the next attempt.
    if (conversation.peekQueued()) {
      try {
        await conversation.queue(message)
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : String(error) }
      }
      this.#ensureDrain()
      this.#markStateDirty()
      return { accepted: true, delivery: "queued" }
    }

    // Acknowledge only after session admission succeeds: hooks.onReady fires after the prompt is recorded.
    let signalAdmitted!: () => void
    const admitted = new Promise<void>((resolve) => {
      signalAdmitted = resolve
    })
    const settled = this.#drive(message, signalAdmitted).then(
      () => "settled" as const,
      () => "settled" as const,
    )
    const outcome = await Promise.race([admitted.then(() => "admitted" as const), settled])
    if (outcome === "settled") return { accepted: false, reason: "The prompt could not be submitted." }
    this.#markStateDirty()
    return { accepted: true, delivery: "started" }
  }

  stop() {
    this.#settlePending(false)
    this.app.conversation.cancel()
  }

  /** Resolves the pending permission request. Stale or unknown ids are ignored, so a cancelled request stays denied. */
  respondToPermission(id: number, allow: boolean) {
    if (!Number.isInteger(id) || this.#pending?.request.id !== id) return
    const pending = this.#pending
    this.#pending = undefined
    pending.resolve(allow)
    this.#markStateDirty()
  }

  /** Called by the main process when the auto-updater has a release ready to install. */
  setUpdateAvailable(version: string): void {
    if (this.#update?.version === version) return
    this.#update = { version }
    this.#markStateDirty()
  }

  async installUpdate(): Promise<void> {
    await this.options.installUpdate?.()
  }

  async selectSession(sessionId: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: "Otis is restarting to finish an update." }
    if (this.#switching) return { ok: false, reason: "Switching workspaces — try again in a moment." }
    if (this.#locating) return { ok: false, reason: "Locating the working folder — try again in a moment." }
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "Invalid session id." }
    // Held synchronously from here until the open settles: a prompt admitted in between would run against the
    // wrong workspace state (the read-only restriction lands only after the load).
    this.#sessionSelecting += 1
    try {
      // The palette row may be stale: another instance can register the dir's workspace after the list loaded.
      // Re-resolve now — a known, present, different folder means this session belongs to a workspace switch.
      if (dirName !== undefined && dirName !== basename(defaultSessionDirectory(this.app.cwd))) {
        const registered = await readWorkspacePath(join(sessionRootDirectory(), dirName))
        if (registered && resolve(registered) !== this.app.cwd && (await pathExists(registered))) {
          return await this.switchWorkspace(registered, sessionId, dirName)
        }
      }
      const result = await this.app.sessions.select(sessionId, this.#storageFor(dirName))
      if (result === "loaded") {
        await this.#updatePendingWorkspace()
        this.#sessionsCache = undefined
        this.#markStateDirty()
      }
      return this.#selectResult(result)
    } finally {
      this.#sessionSelecting -= 1
    }
  }

  /**
   * Whether the active session's working folder is known and present. Sessions from before workspace
   * registration — or whose folder was since removed — open in place so their history is readable, but agent
   * work stays blocked until the user locates the folder (file tools would otherwise run in the wrong place).
   */
  async #updatePendingWorkspace(): Promise<void> {
    this.#pendingWorkspace = undefined
    const current = this.app.sessions.current
    const dirName = this.app.sessions.currentDirName
    if (!current || !dirName) return
    if (dirName === basename(defaultSessionDirectory(this.app.cwd))) return // the workspace's own store is home
    const registered = await readWorkspacePath(join(sessionRootDirectory(), dirName))
    if (registered && (await pathExists(registered))) return
    this.#pendingWorkspace = { dirName, sessionId: current.id }
    // An in-place session is a read-only view (prompts are rejected): drop the write lock so the locate
    // switch — or another Otis instance — can acquire it. Writes resume only after the workspace is real.
    await this.app.sessions.releaseLock()
  }

  /** Storage identity for a session row: its dir under the shared sessions root, when the caller knows it. */
  #storageFor(dirName: string | undefined): { directory: string } | undefined {
    if (dirName === undefined) return undefined
    if (!/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid session directory")
    return { directory: join(sessionRootDirectory(), dirName) }
  }

  /** The palette recomputes history when it opens, so sessions a TUI instance created get listed. */
  refreshSessions(): void {
    this.#sessionsCache = undefined
    this.#markStateDirty()
  }

  #selectResult(result: "noop" | "loaded" | "locked"): SessionOpResult {
    if (result === "locked") return { ok: false, reason: "That session is open in another Otis window." }
    if (result === "noop") return { ok: false, reason: "Finish the current work before switching sessions." }
    return { ok: true }
  }

  /**
   * Moves the window to another workspace, optionally straight into one of its sessions (global history). The
   * destination application — and session, lock included — is fully acquired before the current one shuts down,
   * so any failure leaves this workspace running untouched. `dirName` pins the session's storage identity when
   * the caller located history by hand; without it the session must live in the folder's own store.
   */
  async switchWorkspace(path: string, sessionId?: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#locating) return { ok: false, reason: "Locating the working folder — try again in a moment." }
    return this.#performSwitch(path, sessionId, dirName)
  }

  /** The switch itself; locateWorkspace calls this directly since it holds the locating guard. */
  async #performSwitch(path: string, sessionId?: string, dirName?: string): Promise<SessionOpResult> {
    const cwd = resolve(path)
    if (this.#disposed) return { ok: false, reason: "Otis is restarting to finish an update." }
    if (cwd === this.app.cwd) return sessionId ? this.selectSession(sessionId, dirName) : { ok: true }
    if (this.#switching) return { ok: false, reason: "A workspace switch is already in progress." }
    if (this.app.conversation.busy || this.#draining || this.#selecting > 0 || this.#modelLoad) {
      return { ok: false, reason: "Finish the current work before switching workspaces." }
    }
    // Set synchronously, before any await: two overlapping calls must not both pass validation.
    this.#switching = true
    try {
      if (!(await pathExists(cwd)) || !(await stat(cwd)).isDirectory()) {
        // Folder gone but history present: open the session in place; the locate flow takes it from there.
        // Awaited, so #switching stays held until loading and read-only classification finish.
        if (sessionId && dirName) return await this.#switchFallbackSelect(sessionId, dirName)
        return { ok: false, reason: "That folder is no longer available." }
      }
      const sessionDir = this.#storageFor(dirName)?.directory ?? defaultSessionDirectory(cwd)
      if (sessionId && !(await pathExists(sessionFile({ cwd, directory: sessionDir }, sessionId)))) {
        return { ok: false, reason: "That session is no longer available." }
      }

      let next: Application
      try {
        next = await Application.create({ cwd })
      } catch (error) {
        return { ok: false, reason: `Could not open that folder: ${errorMessage(error)}` }
      }

      // Open the destination session (write lock included) before committing: a refusal here must not strand
      // the user in a workspace they never entered.
      if (sessionId) {
        const result = this.#selectResult(await next.sessions.select(sessionId, { directory: sessionDir }))
        if (!result.ok) {
          await next.shutdown()
          return result
        }
      }

      this.#unsubscribeTranscript()
      await this.app.shutdown()
      this.#app = next
      this.#unsubscribeTranscript = next.transcript.subscribe((change) => this.#onTranscriptChange(change))
      this.#queuedChanges = []
      this.#pendingWorkspace = undefined // the destination workspace is real and present
      this.#sessionsCache = undefined
      this.#modelState = next.models.client ? "ready" : next.hasConfiguredSelection() ? "starting" : "unconfigured"
      this.#modelError = undefined
      this.#modelLoad = undefined
      void this.#startSavedSelection()
      this.#revision += 1
      this.options.send({
        type: "transcript",
        revision: this.#revision,
        ops: [{ op: "reset", entries: [...next.transcript.entries] }],
      })
      await saveLastWorkspace(cwd)
      this.#markStateDirty()
      return { ok: true }
    } finally {
      this.#switching = false
    }
  }

  /** Opens a session in the current window without its workspace — the locate flow follows from the banner. */
  async #switchFallbackSelect(sessionId: string, dirName: string): Promise<SessionOpResult> {
    // Defense in depth alongside #switching (held by the caller through this await): no prompt slips in mid-load.
    this.#sessionSelecting += 1
    try {
      const result = await this.app.sessions.select(sessionId, this.#storageFor(dirName))
      if (result === "loaded") {
        await this.#updatePendingWorkspace()
        this.#sessionsCache = undefined
        this.#markStateDirty()
      }
      return this.#selectResult(result)
    } finally {
      this.#sessionSelecting -= 1
    }
  }

  /** "Open Folder" — always a plain workspace switch, never a locate; previewing history stays unregistered. */
  async openWorkspace(path: string): Promise<SessionOpResult> {
    return this.switchWorkspace(path)
  }

  /**
   * The locate banner's action: associates the pending read-only session with the picked folder and completes
   * recovery. Picking the folder already open in this window reacquires the session's write lock in place —
   * selecting it again would no-op against itself and leave the session stuck read-only.
   */
  async locateWorkspace(path: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: "Otis is restarting to finish an update." }
    // Mutual exclusion, both directions: session operations refuse while a locate runs, and a locate refuses
    // while any of them is in flight — otherwise an earlier selection settling mid-locate could be relocked.
    if (this.#locating) return { ok: false, reason: "Locating the working folder — try again in a moment." }
    if (this.#switching) return { ok: false, reason: "Switching workspaces — try again in a moment." }
    if (this.#sessionSelecting > 0) return { ok: false, reason: "A session is still opening — try again in a moment." }
    const pending = this.#pendingWorkspace
    if (!pending) return { ok: false, reason: "Nothing is waiting for a working folder." }
    if (typeof path !== "string" || !path) return { ok: false, reason: "No folder was picked." }
    // Held synchronously from here: session operations are refused until recovery completes, so the session
    // that gets its write access back is provably the one whose folder was registered.
    this.#locating = true
    try {
      if (!(await pathExists(path))) return { ok: false, reason: "That folder is no longer available." }
      await registerWorkspacePath(join(sessionRootDirectory(), pending.dirName), path)
      // Registered first: even if the switch is refused (busy elsewhere), the folder association survives.
      // Verify the pending session is still the active one before touching write access — the guard makes a
      // mismatch impossible through the public API, so one here means internal drift: fail, don't unlock.
      if (
        this.#pendingWorkspace !== pending ||
        this.app.sessions.current?.id !== pending.sessionId ||
        this.app.sessions.currentDirName !== pending.dirName
      ) {
        return { ok: false, reason: "The session changed while locating — try again." }
      }
      if (resolve(path) === this.app.cwd) {
        const relock = await this.app.sessions.relock()
        if (relock === "locked") return { ok: false, reason: "That session is open in another Otis window." }
        this.#pendingWorkspace = undefined
        this.#sessionsCache = undefined
        this.#markStateDirty()
        return { ok: true }
      }
      return await this.#performSwitch(path, pending.sessionId, pending.dirName)
    } finally {
      this.#locating = false
    }
  }

  /** "Locate workspace": a folder the user picked for history that predates workspace registration. */
  async registerWorkspace(dirName: string, path: string): Promise<SessionOpResult> {
    if (typeof dirName !== "string" || !/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid session directory")
    if (typeof path !== "string" || !path) return { ok: false, reason: "No folder was picked." }
    if (!(await pathExists(path))) return { ok: false, reason: "That folder is no longer available." }
    await registerWorkspacePath(join(sessionRootDirectory(), dirName), path)
    this.#sessionsCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  /** The cached global session list; invalidated by every operation that creates, opens, or removes one. */
  async #globalSessions(): Promise<GlobalSessionPickerItem[]> {
    if (this.#sessionsCache === undefined) {
      this.#sessionsCache = await listGlobalSessionPickerItems({
        activeId: this.app.sessions.current?.id,
        activeDirName: this.app.sessions.currentDirName,
        seeds: [this.app.cwd],
      })
    }
    return this.#sessionsCache
  }

  /** The command palette's session search, across every workspace's stored sessions. */
  async searchSessions(query: string): Promise<GlobalSessionPickerItem[]> {
    return searchGlobalSessionPickerItems(typeof query === "string" ? query : "", {
      activeId: this.app.sessions.current?.id,
      activeDirName: this.app.sessions.currentDirName,
      seeds: [this.app.cwd],
    })
  }

  startNewSession(): SessionOpResult {
    if (this.#disposed) return { ok: false, reason: "Otis is restarting to finish an update." }
    if (this.#switching) return { ok: false, reason: "Switching workspaces — try again in a moment." }
    if (this.#locating) return { ok: false, reason: "Locating the working folder — try again in a moment." }
    if (!this.app.sessions.startNew()) return { ok: false, reason: "Finish the current work before starting over." }
    this.#pendingWorkspace = undefined
    this.#sessionsCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  async deleteSession(sessionId: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: "Otis is restarting to finish an update." }
    if (this.#switching) return { ok: false, reason: "Switching workspaces — try again in a moment." }
    if (this.#locating) return { ok: false, reason: "Locating the working folder — try again in a moment." }
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "Invalid session id." }
    const result = await this.app.sessions.delete(sessionId, this.#storageFor(dirName))
    if (result === "locked") return { ok: false, reason: "That session is open in another Otis window." }
    if (result === "busy") return { ok: false, reason: "Finish the current work before deleting sessions." }
    if (this.app.sessions.current === undefined) this.#pendingWorkspace = undefined
    this.#sessionsCache = undefined
    void this.#refreshStats()
    this.#markStateDirty()
    return { ok: true }
  }

  /**
   * Lists the picker catalog for this machine. PAIR endpoints are user-managed and often offline: a discovery
   * failure empties that section instead of blanking the whole picker, matching the hosted-list behavior.
   */
  async listModels(): Promise<ModelPickerItem[]> {
    const discover = this.options.discoverPair ?? discoverPairModels
    const endpoints = this.app.pairEndpoints
    let pairModels: PairCatalogModel[] = []
    if (endpoints.ollama || endpoints.lmStudio) {
      try {
        const discovery = await discover(endpoints)
        pairModels = [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])]
      } catch {
        pairModels = []
      }
    }
    const activeLocal = this.app.models.activeLocal
    const list = this.options.listPickerItems ?? listModelPickerItems
    const items = await list({
      fireworksApiKey: this.app.fireworksApiKey,
      currentModel: this.app.models.selectedId,
      currentProvider: this.app.models.selectedProvider,
      currentPairEngine: this.app.models.pairEngine,
      pairModels,
      loadStatus: this.#modelLoad,
      loadedLocalModel: activeLocal
        ? { model: activeLocal.spec.id, contextLength: activeLocal.contextLength }
        : undefined,
    })
    this.#lastPickerItems = items
    return items
  }

  /**
   * Switches the selected model, mirroring the TUI picker: the request joins the model host's selection queue in
   * click order (a newer selection supersedes one in flight), is validated against a fresh catalog inside the
   * queue, and is persisted before it commits. Local progress is reported through status events as `modelLoad`.
   * Prompt admission is rejected for the whole span so a turn can never overlap preparation.
   */
  async selectModel(id: string): Promise<ModelSelectResult> {
    if (typeof id !== "string" || !id) return { ok: false, reason: "Invalid model id." }
    // Only running work blocks a switch; parked follow-ups stay queued and drain once the switch settles.
    if (this.#deleting || this.app.conversation.busy || this.#draining) {
      return { ok: false, reason: "Finish the current work before switching models." }
    }
    // Held synchronously from here, before the first await, until the request settles: a prompt submitted during
    // the switch is rejected instead of racing preparation that may stop the server serving it.
    this.#selecting += 1
    try {
      const selection = await this.app.models.enqueueSelection(async (signal) => {
        // The catalog lookup runs inside the queue: request order is click order, and a newer click supersedes
        // this one even while its catalog fetch is still in flight.
        let items: ModelPickerItem[]
        try {
          items = await this.listModels()
        } catch (error) {
          return { ok: false as const, reason: errorMessage(error) }
        }
        if (signal.aborted || this.#disposed) return { ok: false as const, reason: "The selection was superseded." }
        const item = items.find(
          (entry): entry is ModelPickerChoice =>
            entry.kind === "model" && (entry.provider === "pair" ? entry.selectionKey === id : entry.id === id),
        )
        if (!item) return { ok: false as const, reason: "That model is no longer in the catalog." }
        // "Active" only shortcuts when the selection has a live client; without one the row is a failed start and
        // selecting it must run preparation again.
        if (item.active && this.app.models.client) return { ok: true as const }
        if (!isSelectablePickerItem(item)) {
          const label = "availabilityLabel" in item ? item.availabilityLabel : undefined
          return { ok: false as const, reason: label ?? "This model is not available on this machine." }
        }
        // Defense in depth: no driver can start while a selection is open, so running work here means a turn
        // outlived the entry check. Parked follow-ups are safe — #ensureDrain holds them until settle.
        if (this.app.conversation.busy || this.#draining) {
          return { ok: false as const, reason: "Finish the current work before switching models." }
        }

        const selected: CatalogModel =
          item.provider === "local"
            ? toLocalCatalogModel(item)
            : item.provider === "pair"
              ? toPairCatalogModel(item)
              : fireworksServingModel(item, this.app.settings.fastServingModels?.includes(item.id) === true)
        // Status rows are keyed the way the renderer keys them: PAIR entries by engine-qualified selectionKey.
        const pickerId = item.provider === "pair" ? item.selectionKey : item.id
        return this.#prepareModelSelection(selected, pickerId, signal, (serving) => saveSelectedModel(serving))
      })
      return selection ?? { ok: false, reason: "The selection was superseded." }
    } finally {
      this.#selecting -= 1
      // Follow-ups admitted during the switch were parked by #ensureDrain; resume them on the settled model,
      // whether the switch committed, failed, or was superseded.
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /**
   * Runs the shared half of a model switch: preparation, persistence, and status bookkeeping. Used by both
   * picker selections and the Fast serving toggle, which re-selects the current model on its other path.
   */
  async #prepareModelSelection(
    selected: CatalogModel,
    pickerId: string,
    signal: AbortSignal,
    persist: (serving: CatalogModel) => Promise<void>,
  ): Promise<ModelSelectResult> {
    this.#setModelLoad(undefined)
    try {
      await this.app.models.persistSelection(selected, {
        signal,
        isExiting: () => this.#disposed,
        isClosed: () => this.#disposed,
        fireworksApiKey: this.app.fireworksApiKey,
        persist,
        onLocalProgress: (progress) => {
          this.#setModelLoad({
            modelId: pickerId,
            status: { label: formatLocalLoadStatus(progress), kind: "progress" },
          })
        },
      })
      this.#setModelLoad(undefined)
      // The status bar reads display metadata from settings; keep the in-memory copy in sync with the commit,
      // mirroring what withSelectedModel persists.
      this.app.settings.modelDisplayName = selected.displayName
      this.app.settings.modelFastId = selected.provider === "fireworks" ? selected.fastId : undefined
      this.#modelState = "ready"
      this.#modelError = undefined
      this.#markStateDirty()
      return { ok: true as const }
    } catch (error) {
      this.#setModelLoad(undefined)
      if (signal.aborted || this.#disposed || isAbortError(error)) {
        return { ok: false as const, reason: "The selection was cancelled." }
      }
      const message = errorMessage(error)
      // The failure stays on the picker row until the next attempt; a restored previous model stays ready.
      this.#setModelLoad({ modelId: pickerId, status: { label: `Failed: ${message}`, kind: "error" } })
      if (this.app.models.client) {
        this.#modelState = "ready"
      } else {
        this.#modelState = "failed"
        this.#modelError = message
      }
      return { ok: false as const, reason: message }
    }
  }

  /** Applies and persists a color theme; unknown names are ignored. */
  async setTheme(theme: string) {
    if (!isThemeName(theme)) return
    await saveSelectedTheme(theme)
    this.app.settings.theme = theme
    this.#markStateDirty()
  }

  /** Switches reasoning between trace cards and plain muted text, mirroring the TUI's /thinking toggle. */
  async setThinkingVisible(visible: boolean) {
    if (typeof visible !== "boolean") return
    await saveThinkingVisible(visible)
    this.app.settings.thinkingVisible = visible
    this.#markStateDirty()
  }

  /**
   * Toggles Fast serving for the selected hosted model, mirroring the TUI's /fast command: the model is
   * re-selected on its fast or standard path and the preference is persisted per base model id.
   */
  async setFastServing(fast: boolean): Promise<ModelSelectResult> {
    if (typeof fast !== "boolean") return { ok: false as const, reason: "Invalid Fast serving flag." }
    if (this.#deleting || this.app.conversation.busy || this.#draining) {
      return { ok: false as const, reason: "Finish the current work before changing Fast serving." }
    }
    if (this.app.models.selectedProvider !== "fireworks" || !this.app.models.selectedId) {
      return { ok: false as const, reason: "Fast serving is not available for this model." }
    }
    this.#selecting += 1
    try {
      const selection = await this.app.models.enqueueSelection(async (signal) => {
        const selectedId = this.app.models.selectedId
        if (!selectedId || this.app.models.selectedProvider !== "fireworks") {
          return { ok: false as const, reason: "Fast serving is not available for this model." }
        }
        if (isFastFireworksModel(selectedId) === fast) return { ok: true as const }
        if (signal.aborted || this.#disposed) return { ok: false as const, reason: "The selection was superseded." }
        const baseId = baseFireworksModelId(selectedId) ?? selectedId
        const cached = (this.#lastPickerItems ?? []).find(
          (entry): entry is FireworksPickerChoice =>
            entry.kind === "model" && entry.provider === "fireworks" && entry.id === baseId,
        )
        let item = cached
        if (!item?.fastId) {
          try {
            this.#lastPickerItems = await this.listModels()
          } catch (error) {
            return { ok: false as const, reason: errorMessage(error) }
          }
          item = this.#lastPickerItems.find(
            (entry): entry is FireworksPickerChoice =>
              entry.kind === "model" && entry.provider === "fireworks" && entry.id === baseId,
          )
        }
        if (!item?.fastId) return { ok: false as const, reason: "Fast serving is not available for this model." }
        const result = await this.#prepareModelSelection(
          fireworksServingModel(item, fast),
          item.id,
          signal,
          async (serving) => {
            if (serving.provider !== "fireworks") throw new Error("Fast serving only applies to hosted models.")
            await saveFastServingSelection(serving, fast)
          },
        )
        if (result.ok) {
          const enabled = new Set(this.app.settings.fastServingModels ?? [])
          if (fast) enabled.add(baseId)
          else enabled.delete(baseId)
          this.app.settings.fastServingModels = [...enabled].sort()
        }
        return result
      })
      return selection ?? { ok: false as const, reason: "The selection was superseded." }
    } finally {
      this.#selecting -= 1
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /**
   * Validates and activates a Fireworks API key, mirroring the TUI's /settings hosted flow: the key is checked
   * against the hosted catalog before it is saved, and a live hosted client is rebuilt onto the new key.
   */
  async setFireworksApiKey(apiKey: string): Promise<ModelSelectResult> {
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return { ok: false as const, reason: "Fireworks API key is required." }
    }
    const key = apiKey.trim()
    const list = this.options.listToolCapableModels ?? listToolCapableModels
    try {
      const models = await list(key, {})
      if (models.length === 0) {
        return { ok: false as const, reason: "The hosted provider returned no public models with tool support." }
      }
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    }
    await saveFireworksApiKey(key)
    this.app.fireworksApiKey = key
    if (this.app.models.selectedProvider === "fireworks" && this.app.models.selectedId) {
      this.app.models.client = new FireworksClient({ apiKey: key, model: this.app.models.selectedId })
      // A saved hosted model waiting on a key becomes chat-ready the moment the key lands.
      this.#modelState = "ready"
      this.#modelError = undefined
    }
    this.#markStateDirty()
    return { ok: true as const }
  }

  /**
   * Validates, probes, and persists NVIDIA PAIR endpoints, mirroring the TUI's /settings pair flow: only
   * endpoints whose engine actually responds are kept, and choosing a model happens from the picker afterwards.
   */
  async connectPairEndpoints(input: { ollama?: string; lmStudio?: string }): Promise<ModelSelectResult> {
    if (!input || typeof input !== "object") {
      return { ok: false as const, reason: "Enter at least one NVIDIA PAIR endpoint." }
    }
    const requested: PairEndpoints = {}
    const ollama = typeof input.ollama === "string" ? input.ollama.trim() : ""
    const lmStudio = typeof input.lmStudio === "string" ? input.lmStudio.trim() : ""
    if (ollama) requested.ollama = ollama
    if (lmStudio) requested.lmStudio = lmStudio
    if (!requested.ollama && !requested.lmStudio) {
      return { ok: false as const, reason: "Enter at least one NVIDIA PAIR endpoint." }
    }
    let normalized: PairEndpoints
    try {
      normalized = normalizePairEndpoints(requested)
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    }
    const discover = this.options.discoverPair ?? discoverPairModels
    let discovery: Awaited<ReturnType<typeof discoverPairModels>>
    try {
      discovery = await discover(normalized)
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    }
    if (!discovery.ollama && !discovery.lmStudio) {
      return {
        ok: false as const,
        reason: "NVIDIA PAIR was not found. Start PAIR, enable Ollama or LM Studio, then copy its local endpoint here.",
      }
    }
    if ((discovery.ollama?.length ?? 0) + (discovery.lmStudio?.length ?? 0) === 0) {
      return {
        ok: false as const,
        reason: "PAIR is running, but its cluster has no available models. Add a model in PAIR and try again.",
      }
    }
    const endpoints: PairEndpoints = {}
    if (discovery.ollama && normalized.ollama) endpoints.ollama = normalized.ollama
    if (discovery.lmStudio && normalized.lmStudio) endpoints.lmStudio = normalized.lmStudio
    await savePairEndpoints(endpoints)
    const previous = this.app.pairEndpoints
    this.app.pairEndpoints = { ...endpoints }
    // An active PAIR selection must follow its endpoint: rebuild on change, invalidate when its engine is gone.
    if (this.app.models.selectedProvider === "pair" && this.app.models.selectedId) {
      const engine = this.app.models.pairEngine
      const before = pairEndpointForEngine(previous, engine)
      const after = pairEndpointForEngine(endpoints, engine)
      if (after && after !== before) {
        this.app.models.client = new PairClient({ baseURL: after, model: this.app.models.selectedId })
        this.#modelState = "ready"
        this.#modelError = undefined
      } else if (!after && before) {
        this.app.models.client = undefined
        this.#modelState = "failed"
        this.#modelError =
          "The NVIDIA PAIR endpoint for the selected model is no longer available. Reconnect or choose another model."
      }
    }
    this.#lastPickerItems = undefined
    this.#markStateDirty()
    return { ok: true as const }
  }

  /** The downloaded local models for the settings delete list, labeled like the TUI's delete menu rows. */
  async listDownloadedModels(): Promise<DownloadedLocalModel[]> {
    const downloaded = await listDownloadedLocalModels()
    return downloaded.map((model) => {
      const active = this.app.models.selectedProvider === "local" && this.app.models.selectedId === model.id
      return {
        id: model.id,
        displayName: model.displayName,
        detail: `${active ? "Active · " : ""}${model.quant} · ${formatMemoryLabel(localModelWeightBytes(model))}`,
        active,
      }
    })
  }

  /**
   * Deletes a downloaded local model, mirroring the TUI's /settings delete-model flow including the rollback.
   * Holds the selection counter for the entire operation — the same exclusion a model switch gets — so a prompt
   * cannot be admitted, and another selection cannot commit and then be cleared, mid-delete.
   */
  async deleteLocalModel(modelId: string): Promise<ModelSelectResult> {
    if (this.#deleting || this.app.conversation.busy || this.#draining || this.#selecting > 0) {
      return { ok: false as const, reason: "Finish the current work before deleting a model." }
    }
    const spec = findLocalModel(modelId)
    if (!spec) return { ok: false as const, reason: "That model is not in the local catalog." }

    this.#deleting = true
    this.#selecting += 1
    try {
      return await this.#deleteLocalModel(spec)
    } finally {
      this.#deleting = false
      this.#selecting -= 1
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  async #deleteLocalModel(spec: NonNullable<ReturnType<typeof findLocalModel>>): Promise<ModelSelectResult> {
    await this.cancelModelSelection()
    const active = this.app.models.selectedProvider === "local" && this.app.models.selectedId === spec.id
    const previousActive = this.app.models.activeLocal
    const previousModel = catalogModelFromSpec(spec, previousActive?.contextLength)
    let settingsCleared = false
    try {
      const downloaded = await listDownloadedLocalModels()
      const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id
      if (active) {
        await clearSelectedModel()
        settingsCleared = true
      }
      if (active || deletingLast) await this.app.models.llama.stop()
      await deleteLocalGguf(spec)
    } catch (error) {
      let failure = error
      if (active && settingsCleared) {
        try {
          await saveSelectedModel(previousModel)
          if (previousActive) await this.app.models.restorePrevious(previousActive)
        } catch (rollbackError) {
          failure = new AggregateError(
            [error, rollbackError],
            `${errorMessage(error)} The active local model could not be restored.`,
          )
        }
      }
      return { ok: false as const, reason: `Could not delete ${spec.displayName}: ${errorMessage(failure)}` }
    }

    if (active) {
      this.app.models.cancelPrepare()
      this.app.models.activeLocal = undefined
      this.app.models.selectedId = undefined
      this.app.models.selectedProvider = undefined
      this.app.models.client = undefined
      this.app.models.autoCompactAtTokens = autoCompactThreshold()
      this.#modelState = "unconfigured"
      this.#modelError = undefined
    }
    this.#lastPickerItems = undefined
    this.#markStateDirty()
    return { ok: true as const }
  }

  /** Session-only debug mode; applies from the next turn, matching the TUI. */
  setDebugMode(enabled: boolean) {
    if (typeof enabled !== "boolean") return
    this.#debug = enabled
    this.#markStateDirty()
  }

  async cancelModelSelection() {
    this.app.models.cancelSelection()
    await this.app.models.waitForSelection()
    // A selection aborted before it started never ran its own cleanup; clear any stale progress row.
    if (this.#modelLoad?.status.kind === "progress") this.#setModelLoad(undefined)
    // Cancelling the saved model's startup leaves nothing to serve prompts: surface it as a failed start so the
    // picker's active row becomes a real retry instead of a dead shortcut.
    if (!this.app.models.client && this.#modelState === "starting") {
      this.#modelState = "failed"
      this.#modelError = "The model start was cancelled."
      this.#markStateDirty()
    }
  }

  /** The full transcript of one delegated run for the trace view; an empty list when the run is gone. */
  getSubagentTrace(toolCallId: string): TranscriptEntry[] {
    const trace = this.app.subagents.get(toolCallId)
    return trace ? [...trace.transcript.entries] : []
  }

  /** Persists the delegated-runs rail preference, mirroring the TUI's subagent panel setting. */
  async setAgentsPanelVisible(visible: boolean) {
    if (typeof visible !== "boolean") return
    this.app.settings.subagentPanelVisible = visible
    await saveSubagentPanelVisible(visible)
    this.#markStateDirty()
  }

  /** The renderer process is gone: cancel active execution and deny any unanswered approval. */
  handleRendererGone() {
    this.#rendererGone = true
    this.#settlePending(false)
    this.app.conversation.cancel()
  }

  async shutdown() {
    this.#disposed = true
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    this.app.models.cancelSelection()
    this.#settlePending(false)
    this.#unsubscribeTranscript()
    await this.#flushing
    await this.app.shutdown()
  }

  /** The live application for the current workspace; re-pointed by switchWorkspace. Exposed for tests. */
  get app(): Application {
    return this.#app
  }

  /**
   * Runs a prompt and then drains the shared follow-up queue, mirroring the TUI: every settled turn (completed,
   * interrupted, or failed) hands the next queued prompt back to the conversation. Resolves when the first prompt
   * leaves the busy loop; `signalAdmitted` fires as soon as that prompt is durably recorded.
   */
  async #drive(first: UserChatMessage | QueuedPrompt, signalAdmitted?: () => void): Promise<"settled"> {
    let input: UserChatMessage | QueuedPrompt = first
    let hooks = this.#hooks(signalAdmitted)
    this.#draining = true
    try {
      for (;;) {
        const result = await this.app.conversation.start(input, hooks)
        this.#phase = "idle"
        await this.#onTurnSettled(result)
        if (this.#disposed || this.#rendererGone) return "settled"
        const queued = this.app.conversation.takeQueued()
        if (!queued) return "settled"
        input = queued
        hooks = this.#hooks()
      }
    } finally {
      this.#draining = false
      this.#phase = "idle"
      this.#sessionsCache = undefined
      this.#markStateDirty()
      this.#flushNow()
    }
  }

  /**
   * Starts a drain-only driver when a queued follow-up has no live loop to pick it up — its session admission may
   * have completed after the previous turn's driver already exited. The flag transition and takeQueued() are
   * synchronous with respect to the exiting loop's finally, so a follow-up cannot be both missed and undriven.
   */
  #ensureDrain() {
    // A model switch in flight parks queued work: preparation may stop the server the next turn would run on.
    // selectModel re-triggers the drain when its last open selection settles.
    if (this.#draining || this.#disposed || this.#rendererGone || this.#selecting > 0) return
    // Nothing can serve the queue without a usable client — after the active model is deleted, or after a
    // failed start. Keep the queue parked; a selection's settle re-triggers the drain once a model is ready.
    if (!this.app.models.client) return
    const queued = this.app.conversation.takeQueued()
    if (!queued) return
    void this.#drive(queued)
  }

  async #onTurnSettled(result: ConversationTurnResult) {
    void this.#refreshStats()
    if (result.status === "complete") {
      const session = this.app.sessions.current
      if (session && !this.app.sessions.title) {
        void this.app.sessions.generateTitle(session).then(() => this.#markStateDirty())
      }
    }
    this.#markStateDirty()
  }

  #hooks(onReady?: () => void): ConversationHooks {
    return {
      sink: {
        // Transcript mutations reach the renderer through the store subscription; the sink only carries status.
        renderTranscript: () => this.#markStateDirty(),
        renderSubagents: () => this.#markStateDirty(),
        setPhase: (phase) => {
          this.#phase = phase
          this.#markStateDirty()
        },
        startBusy: () => this.#markStateDirty(),
        stopBusy: () => this.#markStateDirty(),
      },
      debug: this.#debug,
      onReady,
      onContext: () => this.#markStateDirty(),
      onDiff: (added, removed) => {
        this.app.sessions.addDiff(added, removed)
        this.#markStateDirty()
      },
      onPermissionRequest: (request) => this.#askPermission(request),
      onCompletion: () => this.#markStateDirty(),
    }
  }

  /**
   * Starts the saved selection through the model host's selection queue: a model picked while the saved one is
   * still loading supersedes startup, so its late commit can never reactivate the old model over the new one.
   */
  async #startSavedSelection() {
    if (this.app.models.client || !this.app.models.selectedId) return
    await this.app.models.enqueueSelection(async (signal) => {
      try {
        const result = await this.app.startSavedSelection({
          signal,
          isExiting: () => this.#disposed,
          onLocalProgress: (progress) => {
            const modelId = this.app.models.selectedId
            if (modelId) {
              this.#setModelLoad({
                modelId,
                status: { label: formatLocalLoadStatus(progress), kind: "progress" },
              })
            }
          },
        })
        // A superseded, cancelled, or disposed startup leaves model state to whoever took over.
        if (this.#disposed || signal.aborted) return
        this.#setModelLoad(undefined)
        this.#modelState = result === "ready" && this.app.models.client ? "ready" : "unconfigured"
        this.#modelError = undefined
      } catch (error) {
        if (this.#disposed || signal.aborted || isAbortError(error)) return
        this.#setModelLoad(undefined)
        this.#modelState = "failed"
        this.#modelError = errorMessage(error)
        const selectedId = this.app.models.selectedId
        const name = (selectedId && findLocalModel(selectedId)?.displayName) ?? selectedId ?? "model"
        this.app.transcript.addAssistantMessage(`Could not start ${name}: ${this.#modelError}`)
      }
      this.#markStateDirty()
      this.#flushNow()
    })
  }

  #askPermission(request: PermissionRequest): Promise<boolean> {
    // A previous request that never resolved (e.g. an interrupted turn) is denied before a new one is shown.
    this.#settlePending(false)
    const activity = describeToolCall(request.call)
    const pending: PendingPermission = {
      id: ++this.#permissionSeq,
      label: activity.label,
      kind: activity.kind,
      resources: request.decision.resources,
    }
    return new Promise((resolve) => {
      this.#pending = { request: pending, resolve }
      this.#markStateDirty()
    })
  }

  #setModelLoad(load: { modelId: string; status: ModelPickerStatus } | undefined) {
    this.#modelLoad = load
    this.#markStateDirty()
  }

  #settlePending(allow: boolean) {
    const pending = this.#pending
    if (!pending) return
    this.#pending = undefined
    pending.resolve(allow)
    this.#markStateDirty()
  }

  async #refreshStats() {
    try {
      this.#stats = await calculateLocalStats()
    } catch {
      // Stats are informational; a read failure must not surface as an app error.
      return
    }
    if (!this.#disposed) this.#markStateDirty()
  }

  #onTranscriptChange(change: TranscriptChange) {
    this.#queuedChanges.push(change)
    this.#scheduleFlush()
  }

  #markStateDirty() {
    this.#stateDirty = true
    this.#scheduleFlush()
  }

  #scheduleFlush() {
    if (this.#disposed || this.#flushTimer) return
    this.#flushTimer = setTimeout(() => this.#flushNow(), FLUSH_INTERVAL_MS)
  }

  #flushNow() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
    if (this.#disposed) return
    if (this.#flushing) {
      this.#scheduleFlush()
      return
    }
    const changes = this.#queuedChanges.splice(0)
    const sendState = this.#stateDirty
    this.#stateDirty = false
    if (changes.length === 0 && !sendState) return
    this.#flushing = this.#deliver(changes, sendState).finally(() => {
      this.#flushing = undefined
      if (this.#queuedChanges.length > 0 || this.#stateDirty) this.#scheduleFlush()
    })
  }

  async #deliver(changes: TranscriptChange[], sendState: boolean) {
    const ops = this.#toPatchOps(changes)
    if (ops.length > 0) this.options.send({ type: "transcript", revision: ++this.#revision, ops })
    if (sendState) this.options.send({ type: "status", revision: ++this.#revision, status: await this.#status() })
  }

  /** Compacts queued store mutations into renderer ops. A reset invalidates every change queued before it. */
  #toPatchOps(changes: TranscriptChange[]): TranscriptPatchOp[] {
    let lastReset = -1
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      if (changes[index]?.op === "reset") {
        lastReset = index
        break
      }
    }

    const ops: TranscriptPatchOp[] = []
    if (lastReset !== -1) ops.push({ op: "reset", entries: [...this.app.transcript.entries] })

    const upserted = new Set<number>()
    for (const change of changes.slice(lastReset + 1)) {
      if (change.op === "upsert") {
        const entry = this.#entry(change.id)
        if (!entry || upserted.has(entry.id)) continue
        upserted.add(entry.id)
        ops.push({ op: "upsert", entry })
      } else if (change.op === "remove") {
        if (upserted.delete(change.id)) {
          const index = ops.findIndex((op) => op.op === "upsert" && op.entry.id === change.id)
          if (index !== -1) ops.splice(index, 1)
        }
        ops.push({ op: "remove", id: change.id })
      }
    }
    return ops
  }

  #entry(id: number): TranscriptEntry | undefined {
    return this.app.transcript.entries.find((entry) => entry.id === id)
  }

  /** Fast serving availability for the selected model, resolved without a catalog fetch. */
  #fastServingState(): { available: boolean; enabled: boolean } {
    const selectedId = this.app.models.selectedId
    if (this.app.models.selectedProvider !== "fireworks" || !selectedId) {
      return { available: false, enabled: false }
    }
    const enabled = isFastFireworksModel(selectedId)
    const baseId = baseFireworksModelId(selectedId) ?? selectedId
    const available =
      enabled ||
      this.app.settings.modelFastId !== undefined ||
      this.app.settings.fastServingModels?.includes(baseId) === true ||
      this.#lastPickerItems?.some(
        (entry) =>
          entry.kind === "model" && entry.provider === "fireworks" && entry.id === baseId && Boolean(entry.fastId),
      ) === true
    return { available, enabled }
  }

  async #status(): Promise<DesktopStatus> {
    const app = this.app
    return {
      busy: app.conversation.busy || this.#draining,
      phase: this.#phase,
      model: app.models.selectedId
        ? {
            id: app.models.selectedId,
            provider: app.models.selectedProvider ?? "fireworks",
            ...(app.settings.modelDisplayName ? { displayName: app.settings.modelDisplayName } : {}),
          }
        : null,
      modelState: this.#modelState,
      modelError: this.#modelError,
      session: app.sessions.current ? { id: app.sessions.current.id, title: app.sessions.activeLabel() } : null,
      needsWorkspace: this.#pendingWorkspace !== undefined,
      sessions: await this.#globalSessions(),
      workspace: { label: formatWorkspaceLabel(app.cwd), path: app.cwd },
      contextTokens: app.contextTokens(),
      contextLimit: app.models.autoCompactAtTokens,
      diffs: app.sessions.diffs,
      permission: this.#pending?.request ?? null,
      stats: this.#stats,
      modelLoad: this.#modelLoad ?? null,
      agentsPanelVisible: this.app.settings.subagentPanelVisible ?? true,
      theme: this.app.settings.theme ?? "default",
      thinkingVisible: this.app.settings.thinkingVisible ?? false,
      fastServing: this.#fastServingState(),
      hostedConfigured: Boolean(app.fireworksApiKey),
      pairConfigured: Boolean(app.pairEndpoints.ollama || app.pairEndpoints.lmStudio),
      pairEndpoints: { ...app.pairEndpoints },
      debug: this.#debug,
      ...(this.#update ? { update: this.#update } : {}),
      subagents: this.app.subagents.all.map((trace) => ({
        toolCallId: trace.toolCallId,
        title: trace.title,
        status: trace.status,
        ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
        tools: trace.transcript.entries.filter((entry) => entry.kind === "tool").length,
      })),
    }
  }
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
