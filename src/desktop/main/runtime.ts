import { stat } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { Application, formatWorkspaceLabel } from "../../app/application.js"
import type { ConversationHooks, QueuedPrompt } from "../../app/conversation.js"
import {
  type GlobalSessionPickerItem,
  listGlobalSessionPickerItems,
  searchGlobalSessionPickerItems,
} from "../../app/global-sessions.js"
import type { LocalServerInputs } from "../../app/local-servers.js"
import type { TranscriptChange, TranscriptEntry } from "../../app/transcript.js"
import type { ArtifactReference } from "../../artifacts/types.js"
import { autoCompactThreshold } from "../../core/compaction.js"
import { createAttachment, validateAttachments } from "../../inference/attachments.js"
import { listToolCapableModels } from "../../inference/catalog.js"
import { FireworksClient } from "../../inference/client.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../../inference/gguf-cache.js"
import { validateImageAttachments } from "../../inference/images.js"
import { formatLocalLoadStatus } from "../../inference/llama-runtime.js"
import { catalogModelFromSpec, findLocalModel } from "../../inference/local-catalog.js"
import { createUserMessage, imageAttachmentsFromMessages } from "../../inference/messages.js"
import { discoverOmlxModels } from "../../inference/omlx.js"
import { discoverPairModels, type PairDiscovery } from "../../inference/pair.js"
import {
  type FireworksPickerChoice,
  isSelectablePickerItem,
  listModelPickerItems,
  type ModelPickerChoice,
  type ModelPickerItem,
  type ModelPickerStatus,
  toLocalCatalogModel,
  toOmlxCatalogModel,
  toPairCatalogModel,
} from "../../inference/picker-catalog.js"
import {
  baseFireworksModelId,
  fireworksServingModel,
  isFastFireworksModel,
} from "../../inference/serving-path.js"
import {
  type AttachmentContentPart,
  type CatalogModel,
  type ImageContentPart,
  SUPPORTED_IMAGE_EXTENSIONS,
  type UserChatMessage,
} from "../../inference/types.js"
import {
  clearSelectedModel,
  isThemeName,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveLastWorkspace,
  savePermissionMode,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  saveUiLanguage,
  UI_LANGUAGES,
} from "../../local/settings.js"
import { calculateLocalStats } from "../../local/stats.js"
import {
  defaultSessionDirectory,
  readWorkspacePath,
  registerWorkspacePath,
  sessionFile,
  sessionRootDirectory,
} from "../../storage/index.js"
import { describeToolCall } from "../../tools/activity.js"
import type {
  DesktopAttachmentInput,
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  ModelSelectResult,
  ModelState,
  PendingPermission,
  SendPromptResult,
  SessionOpResult,
  TranscriptPatchOp,
  TurnPhase,
} from "../contracts.js"

type DesktopRuntimeOptions = {
  cwd: string
  version: string
  platform: NodeJS.Platform
  /** Delivers the ordered event stream to the renderer. */
  send: (event: DesktopEvent) => void
  /** Test seam for the picker catalog; production uses the real implementations. */
  listPickerItems?: typeof listModelPickerItems
  discoverPair?: typeof discoverPairModels
  discoverOmlx?: typeof discoverOmlxModels
  /** Test seam for verifying a Fireworks key against the hosted catalog. */
  listToolCapableModels?: typeof listToolCapableModels
  /**
   * Quits and installs the downloaded update; provided by the main process once a release is ready.
   */
  installUpdate?: () => Promise<void>
  checkForUpdates?: () => Promise<void>
}

/**
 * Maximum prompt size accepted from the renderer, matching what a session file can reasonably hold.
 */
const MAX_PROMPT_CHARS = 200_000

/** Streaming changes are batched so a fast token stream does not flood the IPC channel. */
const FLUSH_INTERVAL_MS = 32

const RESTARTING = "Otis is restarting to finish an update."
const SWITCHING = "Switching workspaces — try again in a moment."
const LOCATING = "Locating the working folder — try again in a moment."
const SUPERSEDED = "The selection was superseded."
const NO_FAST_SERVING = "Fast serving is not available for this model."

/**
 * Owns the shared Application for one workspace and exposes explicit operations to the GUI.
 * Electron-free so the whole command path is testable; window and IPC wiring live in index.ts and
 * ipc.ts.
 */
export class DesktopRuntime {
  #app!: Application
  #unsubscribe = () => {}
  #revision = 0
  /**
   * Invalidates prompt preparation when the conversation is replaced, including empty-to-empty
   * resets.
   */
  #conversationVersion = 0
  #permissionSeq = 0
  #pending: { request: PendingPermission; resolve: (allow: boolean) => void } | undefined
  #phase: TurnPhase = "idle"
  #modelState: ModelState = "unconfigured"
  #modelError: string | undefined
  /** In-flight selectModel requests; prompt admission is rejected while any are open. */
  #selecting = 0
  /** A session open is in flight; prompts are rejected until its workspace state settles. */
  #sessionSelecting = 0
  /**
   * A locate is completing; session changes are refused so recovery can't attach to the wrong
   * session.
   */
  #locating = false
  /** The most recent picker listing; feeds fast-serving availability without a fetch per status. */
  #lastPickerItems: ModelPickerItem[] | undefined
  /** Session-only debug mode, mirroring the TUI's /debug toggle. */
  #debug = false
  /**
   * A workspace switch in flight; switches and conflicting session operations are refused until it
   * settles.
   */
  #switching = false
  /**
   * Session opened in place whose working folder is unknown or gone; agent work is blocked until
   * located.
   */
  #pendingWorkspace: { dirName: string; sessionId: string } | undefined
  /**
   * Global session listing is disk-heavy; the shared promise coalesces concurrent status snapshots.
   */
  #sessionsCache: Promise<GlobalSessionPickerItem[]> | undefined
  /** A local-model deletion is in flight; model switches are rejected until its cleanup settles. */
  #deleting = false
  #modelLoad: { modelId: string; status: ModelPickerStatus } | undefined
  #stats: DesktopStatus["stats"]
  #update: DesktopStatus["update"] = { status: "idle" }
  #queuedChanges: TranscriptChange[] = []
  #stateDirty = false
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #flushing: Promise<void> | undefined
  #draining = false
  #disposed = false
  /**
   * Set when the renderer process died; queue draining is suspended until the user sends another
   * prompt.
   */
  #rendererGone = false

  private constructor(
    app: Application,
    private readonly options: DesktopRuntimeOptions,
  ) {
    this.#attach(app)
  }

  static async create(options: DesktopRuntimeOptions) {
    const app = await Application.create({
      cwd: options.cwd,
      outputCapabilities: { mermaid: true },
    })
    return DesktopRuntime.forApplication(app, options)
  }

  /**
   * Builds a runtime around an existing application and starts its saved selection. A saved local
   * model needs its managed server started before any prompt can run, exactly as the TUI does at
   * launch; Fireworks and PAIR selections already have their client from applySavedSelection. This
   * is the test seam for DesktopRuntime.
   */
  static forApplication(app: Application, options: DesktopRuntimeOptions) {
    const runtime = new DesktopRuntime(app, options)
    void runtime.#startSavedSelection()
    void runtime.#refreshStats()
    return runtime
  }

  /**
   * Points the runtime at an application: store subscriptions and the model lifecycle state it
   * starts in.
   */
  #attach(app: Application) {
    this.#app = app
    const transcript = app.transcript.subscribe((change) => this.#onTranscriptChange(change))
    const artifacts = app.artifacts.subscribe(() => this.#markStateDirty())
    this.#unsubscribe = () => {
      transcript()
      artifacts()
    }
    this.#modelState = app.models.client
      ? "ready"
      : app.hasConfiguredSelection()
        ? "starting"
        : "unconfigured"
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

  getArtifact(revision: number) {
    return this.app.artifacts.load(revision)
  }

  async getArtifactFile(id: string, revision: number) {
    const app = this.app
    if (app.artifacts.metadata?.id !== id) return undefined
    const conversationVersion = this.#conversationVersion
    const file = await app.artifacts.exportFile(revision)
    return this.app === app && this.#conversationVersion === conversationVersion ? file : undefined
  }

  async openArtifact(reference: ArtifactReference, version?: number): Promise<SessionOpResult> {
    if (!this.app.openArtifact(reference, version))
      return { ok: false, reason: "This artifact is no longer available." }
    return { ok: true }
  }

  async sendPrompt(
    text: string,
    inputs: readonly DesktopAttachmentInput[] = [],
  ): Promise<SendPromptResult> {
    const rejection = this.#promptRejection()
    if (rejection) return { accepted: false, reason: rejection }
    const app = this.app
    const client = app.models.client
    const conversationVersion = this.#conversationVersion
    // A live renderer sending a prompt un-gates the queue after a renderer crash.
    this.#rendererGone = false
    if (!text.trim() && inputs.length === 0)
      return { accepted: false, reason: "The prompt is empty." }
    if (text.length > MAX_PROMPT_CHARS)
      return { accepted: false, reason: "The prompt is too long." }
    const noVision = (): SendPromptResult => {
      const name = app.settings.modelDisplayName ?? app.models.selectedId ?? "The selected model"
      return {
        accepted: false,
        reason: `${name} does not support image input. Choose a vision model.`,
      }
    }
    const claimsImage = inputs.some(
      (input) =>
        input.mimeType.toLowerCase().startsWith("image/") ||
        (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(
          extname(input.name).toLowerCase(),
        ),
    )
    if (claimsImage && app.models.supportsImageInput !== true) return noVision()

    const attachments: AttachmentContentPart[] = []
    try {
      for (const input of inputs) {
        attachments.push(
          await createAttachment(input.bytes, input.name, input.mimeType || undefined),
        )
        validateAttachments(attachments)
      }
      // Parsing can yield while a session, workspace, model, or renderer changes. Admission must
      // still target the conversation and model for which the user submitted these attachments.
      const currentRejection = this.#promptRejection()
      if (currentRejection) return { accepted: false, reason: currentRejection }
      if (
        this.#rendererGone ||
        this.app !== app ||
        this.#conversationVersion !== conversationVersion ||
        app.models.client !== client
      ) {
        return {
          accepted: false,
          reason: "The conversation or model changed while reading attachments. Please send again.",
        }
      }
      const newImages = attachments.filter(
        (attachment): attachment is ImageContentPart => attachment.type === "image",
      )
      if (newImages.length > 0 && app.models.supportsImageInput !== true) return noVision()
      validateImageAttachments([
        ...imageAttachmentsFromMessages(app.transcript.history),
        ...newImages,
      ])
    } catch (error) {
      return { accepted: false, reason: errorMessage(error) }
    }

    const message = createUserMessage(text, attachments)
    const { conversation } = app
    if (conversation.busy || this.#draining) {
      // steer() and queue() admit the prompt to the session before returning, so an accepted result
      // here means the follow-up is durably recorded. A rejection means nothing was saved and the
      // draft must be kept.
      try {
        const delivery = await conversation.steer(message, () => {})
        if (delivery === "queued") this.#ensureDrain()
        this.#markStateDirty()
        return { accepted: true, delivery }
      } catch (error) {
        return { accepted: false, reason: errorMessage(error) }
      }
    }

    // Queued follow-ups waiting without a driver (e.g. suspended by a renderer crash) run first:
    // admit the new prompt behind them and restart the driver, preserving send order. The queue is
    // only consumed after the new admission succeeds — a failed admission leaves the backlog intact
    // for the next attempt.
    if (conversation.peekQueued()) {
      try {
        await conversation.queue(message)
      } catch (error) {
        return { accepted: false, reason: errorMessage(error) }
      }
      this.#ensureDrain()
      this.#markStateDirty()
      return { accepted: true, delivery: "queued" }
    }

    // Acknowledge only after session admission succeeds: hooks.onReady fires after the prompt is
    // recorded.
    let signalAdmitted!: () => void
    const admitted = new Promise<"admitted">((resolve) => {
      signalAdmitted = () => resolve("admitted")
    })
    const settled = this.#drive(message, signalAdmitted).catch(() => "settled" as const)
    if ((await Promise.race([admitted, settled])) === "settled") {
      return { accepted: false, reason: "The prompt could not be submitted." }
    }
    this.#markStateDirty()
    return { accepted: true, delivery: "started" }
  }

  #promptRejection(): string | undefined {
    // Once shutdown starts (update install), the session lock is released and no renderer receives
    // updates.
    if (this.#disposed) return RESTARTING
    if (this.#switching) return SWITCHING
    if (this.#pendingWorkspace) return "Locate the working folder to continue this session."
    // A foreign session's read-only restriction is set after its async open; prompts must not slip
    // through first.
    if (this.#sessionSelecting > 0) return "Opening the session — try again in a moment."
    // Model switching and prompt admission are mutually exclusive: preparation may stop the server
    // this prompt would run on, and the busy window alone does not cover the asynchronous selection
    // span.
    if (this.#selecting > 0) return "A model switch is in progress. Try again in a moment."
    if (this.app.models.client) return undefined
    return this.#modelState === "starting"
      ? "The model is still starting. Try again in a moment."
      : (this.#modelError ?? "No model is configured. Set up inference with the Otis CLI first.")
  }

  stop() {
    this.#settlePending(false)
    this.app.conversation.cancel()
  }

  /**
   * Resolves the pending permission request. Stale or unknown ids are ignored, so a cancelled
   * request stays denied.
   */
  respondToPermission(id: number, allow: boolean) {
    if (this.#pending?.request.id === id) this.#settlePending(allow)
  }

  /** Update state belongs to the main-process updater and survives Settings being closed. */
  setUpdateState(update: DesktopStatus["update"]): void {
    this.#update = update
    this.#markStateDirty()
  }

  async checkForUpdates(): Promise<void> {
    if (this.#disposed) return
    await this.options.checkForUpdates?.()
  }

  async installUpdate(): Promise<void> {
    if (this.#disposed || this.#update.status !== "ready") return
    await this.options.installUpdate?.()
  }

  async selectSession(sessionId: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    if (this.#switching) return { ok: false, reason: SWITCHING }
    if (this.#locating) return { ok: false, reason: LOCATING }
    if (!sessionId) return { ok: false, reason: "Invalid session id." }
    // Held synchronously from here until the open settles: a prompt admitted in between would run
    // against the wrong workspace state (the read-only restriction lands only after the load).
    this.#sessionSelecting += 1
    try {
      // The palette row may be stale: another instance can register the dir's workspace after the
      // list loaded. Re-resolve now — a known, present, different folder means this session belongs
      // to a workspace switch.
      if (dirName !== undefined && dirName !== basename(defaultSessionDirectory(this.app.cwd))) {
        const registered = await readWorkspacePath(sessionDir(dirName))
        if (registered && resolve(registered) !== this.app.cwd && (await pathExists(registered))) {
          return await this.switchWorkspace(registered, sessionId, dirName)
        }
      }
      return await this.#selectInPlace(sessionId, dirName)
    } finally {
      this.#sessionSelecting -= 1
    }
  }

  /**
   * Opens a session in the current window. Sessions from before workspace registration — or whose
   * folder was since removed — open in place so their history is readable, but agent work stays
   * blocked until the user locates the folder (file tools would otherwise run in the wrong place);
   * the locate flow follows from the banner.
   */
  async #selectInPlace(sessionId: string, dirName: string | undefined): Promise<SessionOpResult> {
    // Held through the load, also as defense in depth under #switching: no prompt slips in
    // mid-load.
    this.#sessionSelecting += 1
    try {
      const result = await this.app.sessions.select(sessionId, this.#storageFor(dirName))
      if (result !== "loaded") return selectResult(result)
      this.#pendingWorkspace = undefined
      const current = this.app.sessions.current
      const currentDir = this.app.sessions.currentDirName
      // The workspace's own store is home; any other dir must resolve to a present folder.
      if (current && currentDir && currentDir !== basename(defaultSessionDirectory(this.app.cwd))) {
        const registered = await readWorkspacePath(join(sessionRootDirectory(), currentDir))
        if (!registered || !(await pathExists(registered))) {
          this.#pendingWorkspace = { dirName: currentDir, sessionId: current.id }
          // An in-place session is a read-only view (prompts are rejected): drop the write lock so
          // the locate switch — or another Otis instance — can acquire it. Writes resume only after
          // the workspace is real.
          await this.app.sessions.releaseLock()
        }
      }
      this.#sessionsCache = undefined
      this.#markStateDirty()
      return { ok: true }
    } finally {
      this.#sessionSelecting -= 1
    }
  }

  #storageFor(dirName: string | undefined): { directory: string } | undefined {
    return dirName === undefined ? undefined : { directory: sessionDir(dirName) }
  }

  /**
   * The palette recomputes history when it opens, so sessions a TUI instance created get listed.
   */
  refreshSessions(): void {
    this.#sessionsCache = undefined
    this.#markStateDirty()
  }

  /**
   * Moves the window to another workspace, optionally straight into one of its sessions (global
   * history). The destination application — and session, lock included — is fully acquired before
   * the current one shuts down, so any failure leaves this workspace running untouched. `dirName`
   * pins the session's storage identity when the caller located history by hand; without it the
   * session must live in the folder's own store.
   */
  async switchWorkspace(
    path: string,
    sessionId?: string,
    dirName?: string,
  ): Promise<SessionOpResult> {
    if (this.#locating) return { ok: false, reason: LOCATING }
    return this.#performSwitch(path, sessionId, dirName)
  }

  /** The switch itself; locateWorkspace calls this directly since it holds the locating guard. */
  async #performSwitch(
    path: string,
    sessionId?: string,
    dirName?: string,
  ): Promise<SessionOpResult> {
    const cwd = resolve(path)
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    if (cwd === this.app.cwd)
      return sessionId ? this.selectSession(sessionId, dirName) : { ok: true }
    if (this.#switching) return { ok: false, reason: "A workspace switch is already in progress." }
    if (this.app.conversation.busy || this.#draining || this.#selecting > 0 || this.#modelLoad) {
      return { ok: false, reason: "Finish the current work before switching workspaces." }
    }
    // Set synchronously, before any await: two overlapping calls must not both pass validation.
    this.#switching = true
    try {
      if (!(await pathExists(cwd)) || !(await stat(cwd)).isDirectory()) {
        // Folder gone but history present: open the session in place; the locate flow takes it from
        // there. Awaited, so #switching stays held until loading and read-only classification
        // finish.
        if (sessionId && dirName) return await this.#selectInPlace(sessionId, dirName)
        return { ok: false, reason: "That folder is no longer available." }
      }
      const directory = dirName ? sessionDir(dirName) : defaultSessionDirectory(cwd)
      if (sessionId && !(await pathExists(sessionFile({ cwd, directory }, sessionId)))) {
        return { ok: false, reason: "That session is no longer available." }
      }

      let next: Application
      try {
        next = await Application.create({ cwd, outputCapabilities: { mermaid: true } })
      } catch (error) {
        return { ok: false, reason: `Could not open that folder: ${errorMessage(error)}` }
      }

      // Open the destination session (write lock included) before committing: a refusal here must
      // not strand the user in a workspace they never entered.
      if (sessionId) {
        const result = selectResult(await next.sessions.select(sessionId, { directory }))
        if (!result.ok) {
          await next.shutdown()
          return result
        }
      }

      this.#unsubscribe()
      await this.app.shutdown()
      this.#attach(next)
      this.#queuedChanges = []
      this.#pendingWorkspace = undefined // the destination workspace is real and present
      this.#sessionsCache = undefined
      this.#modelError = undefined
      this.#modelLoad = undefined
      void this.#startSavedSelection()
      this.#onTranscriptChange({ op: "reset" })
      this.#markStateDirty()
      await saveLastWorkspace(cwd)
      return { ok: true }
    } finally {
      this.#switching = false
    }
  }

  /**
   * "Open Folder" — always a plain workspace switch, never a locate; previewing history stays
   * unregistered.
   */
  async openWorkspace(path: string): Promise<SessionOpResult> {
    return this.switchWorkspace(path)
  }

  /**
   * The locate banner's action: associates the pending read-only session with the picked folder and
   * completes recovery. Picking the folder already open in this window reacquires the session's
   * write lock in place — selecting it again would no-op against itself and leave the session stuck
   * read-only.
   */
  async locateWorkspace(path: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    // Mutual exclusion, both directions: session operations refuse while a locate runs, and a
    // locate refuses while any of them is in flight — otherwise an earlier selection settling
    // mid-locate could be relocked.
    if (this.#locating) return { ok: false, reason: LOCATING }
    if (this.#switching) return { ok: false, reason: SWITCHING }
    if (this.#sessionSelecting > 0)
      return { ok: false, reason: "A session is still opening — try again in a moment." }
    const pending = this.#pendingWorkspace
    if (!pending) return { ok: false, reason: "Nothing is waiting for a working folder." }
    if (!path) return { ok: false, reason: "No folder was picked." }
    // Held synchronously from here: session operations are refused until recovery completes, so the
    // session that gets its write access back is provably the one whose folder was registered.
    this.#locating = true
    try {
      if (!(await pathExists(path)))
        return { ok: false, reason: "That folder is no longer available." }
      await registerWorkspacePath(join(sessionRootDirectory(), pending.dirName), path)
      // Registered first: even if the switch is refused (busy elsewhere), the folder association
      // survives. Verify the pending session is still the active one before touching write access —
      // the guard makes a mismatch impossible through the public API, so one here means internal
      // drift: fail, don't unlock.
      if (
        this.#pendingWorkspace !== pending ||
        this.app.sessions.current?.id !== pending.sessionId ||
        this.app.sessions.currentDirName !== pending.dirName
      ) {
        return { ok: false, reason: "The session changed while locating — try again." }
      }
      if (resolve(path) !== this.app.cwd)
        return await this.#performSwitch(path, pending.sessionId, pending.dirName)
      if ((await this.app.sessions.relock()) === "locked") {
        return { ok: false, reason: "That session is open in another Otis window." }
      }
      this.#pendingWorkspace = undefined
      this.#sessionsCache = undefined
      this.#markStateDirty()
      return { ok: true }
    } finally {
      this.#locating = false
    }
  }

  /**
   * "Locate workspace": a folder the user picked for history that predates workspace registration.
   */
  async registerWorkspace(dirName: string, path: string): Promise<SessionOpResult> {
    const directory = sessionDir(dirName)
    if (!path) return { ok: false, reason: "No folder was picked." }
    if (!(await pathExists(path)))
      return { ok: false, reason: "That folder is no longer available." }
    await registerWorkspacePath(directory, path)
    this.#sessionsCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  /** The command palette's session search, across every workspace's stored sessions. */
  async searchSessions(query: string): Promise<GlobalSessionPickerItem[]> {
    return searchGlobalSessionPickerItems(query, {
      activeId: this.app.sessions.current?.id,
      activeDirName: this.app.sessions.currentDirName,
      seeds: [this.app.cwd],
    })
  }

  startNewSession(): SessionOpResult {
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    if (this.#switching) return { ok: false, reason: SWITCHING }
    if (this.#locating) return { ok: false, reason: LOCATING }
    if (!this.app.sessions.startNew())
      return { ok: false, reason: "Finish the current work before starting over." }
    this.#pendingWorkspace = undefined
    this.#sessionsCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  async deleteSession(sessionId: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    if (this.#switching) return { ok: false, reason: SWITCHING }
    if (this.#locating) return { ok: false, reason: LOCATING }
    if (!sessionId) return { ok: false, reason: "Invalid session id." }
    const result = await this.app.sessions.delete(sessionId, this.#storageFor(dirName))
    if (result === "locked")
      return { ok: false, reason: "That session is open in another Otis window." }
    if (result === "busy")
      return { ok: false, reason: "Finish the current work before deleting sessions." }
    if (this.app.sessions.current === undefined) this.#pendingWorkspace = undefined
    this.#sessionsCache = undefined
    void this.#refreshStats()
    this.#markStateDirty()
    return { ok: true }
  }

  /**
   * Lists the picker catalog for this machine. PAIR endpoints are user-managed and often offline: a
   * discovery failure empties that section instead of blanking the whole picker, matching the
   * hosted-list behavior.
   */
  async listModels(): Promise<ModelPickerItem[]> {
    const endpoints = this.app.pairEndpoints
    const discovery: Partial<PairDiscovery> =
      endpoints.ollama || endpoints.lmStudio
        ? await (this.options.discoverPair ?? discoverPairModels)(endpoints).catch(() => ({}))
        : {}
    const omlxModels = this.app.models.omlx
      ? await (this.options.discoverOmlx ?? discoverOmlxModels)(this.app.models.omlx).catch(
          () => [],
        )
      : []
    const activeLocal = this.app.models.activeLocal
    const items = await (this.options.listPickerItems ?? listModelPickerItems)({
      fireworksApiKey: this.app.fireworksApiKey,
      currentModel: this.app.models.selectedId,
      currentProvider: this.app.models.selectedProvider,
      currentPairEngine: this.app.models.pairEngine,
      pairModels: [...(discovery.ollama ?? []), ...(discovery.lmStudio ?? [])],
      omlxModels,
      loadStatus: this.#modelLoad,
      loadedLocalModel: activeLocal
        ? { model: activeLocal.spec.id, contextLength: activeLocal.contextLength }
        : undefined,
      // Over-budget cached models stay listed (selection disabled) so they remain deletable from
      // the catalog.
      includeDownloadedUnavailable: true,
    })
    this.#lastPickerItems = items
    return items
  }

  /**
   * Switches the selected model, mirroring the TUI picker: the request joins the model host's
   * selection queue in click order (a newer selection supersedes one in flight), is validated
   * against a fresh catalog inside the queue, and is persisted before it commits. Local progress is
   * reported through status events as `modelLoad`. Prompt admission is rejected for the whole span
   * so a turn can never overlap preparation.
   */
  async selectModel(id: string): Promise<ModelSelectResult> {
    if (!id) return { ok: false, reason: "Invalid model id." }
    // Only running work blocks a switch; parked follow-ups stay queued and drain once the switch
    // settles.
    if (this.#deleting || this.app.conversation.busy || this.#draining) {
      return { ok: false, reason: "Finish the current work before switching models." }
    }
    // Held synchronously from here, before the first await, until the request settles: a prompt
    // submitted during the switch is rejected instead of racing preparation that may stop the
    // server serving it.
    this.#selecting += 1
    try {
      const selection = await this.app.models.enqueueSelection(
        async (signal): Promise<ModelSelectResult> => {
          // The catalog lookup runs inside the queue: request order is click order, and a newer
          // click supersedes this one even while its catalog fetch is still in flight.
          let items: ModelPickerItem[]
          try {
            items = await this.listModels()
          } catch (error) {
            return { ok: false, reason: errorMessage(error) }
          }
          if (signal.aborted || this.#disposed) return { ok: false, reason: SUPERSEDED }
          const item = items.find(
            (entry): entry is ModelPickerChoice =>
              entry.kind === "model" &&
              ("selectionKey" in entry ? entry.selectionKey === id : entry.id === id),
          )
          if (!item) return { ok: false, reason: "That model is no longer in the catalog." }
          // "Active" only shortcuts when the selection has a live client; without one the row is a
          // failed start and selecting it must run preparation again.
          if (item.active && this.app.models.client && item.provider !== "omlx") return { ok: true }
          if (!isSelectablePickerItem(item)) {
            const label = "availabilityLabel" in item ? item.availabilityLabel : undefined
            return { ok: false, reason: label ?? "This model is not available on this machine." }
          }
          // Defense in depth: no driver can start while a selection is open, so running work here
          // means a turn outlived the entry check. Parked follow-ups are safe — #ensureDrain holds
          // them until settle.
          if (this.app.conversation.busy || this.#draining) {
            return { ok: false, reason: "Finish the current work before switching models." }
          }

          const selected: CatalogModel =
            item.provider === "local"
              ? toLocalCatalogModel(item)
              : item.provider === "pair"
                ? toPairCatalogModel(item)
                : item.provider === "omlx"
                  ? toOmlxCatalogModel(item)
                  : fireworksServingModel(
                      item,
                      this.app.settings.fastServingModels?.includes(item.id) === true,
                    )
          // Status rows are keyed the way the renderer keys them: PAIR entries by engine-qualified
          // selectionKey.
          const pickerId = "selectionKey" in item ? item.selectionKey : item.id
          return this.#prepareModelSelection(selected, pickerId, signal, (serving) =>
            saveSelectedModel(serving),
          )
        },
      )
      return selection ?? { ok: false, reason: SUPERSEDED }
    } finally {
      this.#selecting -= 1
      // Follow-ups admitted during the switch were parked by #ensureDrain; resume them on the
      // settled model, whether the switch committed, failed, or was superseded.
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /**
   * Runs the shared half of a model switch: preparation, persistence, and status bookkeeping. Used
   * by both picker selections and the Fast serving toggle, which re-selects the current model on
   * its other path.
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
      // The status bar reads display metadata from settings; keep the in-memory copy in sync with
      // the commit, mirroring what withSelectedModel persists.
      this.app.settings.modelDisplayName = selected.displayName
      this.app.settings.modelFastId =
        selected.provider === "fireworks" ? selected.fastId : undefined
      this.#modelState = "ready"
      this.#modelError = undefined
      this.#markStateDirty()
      return { ok: true }
    } catch (error) {
      this.#setModelLoad(undefined)
      if (signal.aborted || this.#disposed || isAbortError(error)) {
        return { ok: false, reason: "The selection was cancelled." }
      }
      const message = errorMessage(error)
      // The failure stays on the picker row until the next attempt; a restored previous model stays
      // ready.
      this.#setModelLoad({
        modelId: pickerId,
        status: { label: `Failed: ${message}`, kind: "error" },
      })
      if (this.app.models.client) {
        this.#modelState = "ready"
      } else {
        this.#modelState = "failed"
        this.#modelError = message
      }
      return { ok: false, reason: message }
    }
  }

  /** Applies and persists a color theme; unknown names are ignored. */
  async setTheme(theme: string) {
    if (!isThemeName(theme)) return
    await saveSelectedTheme(theme)
    this.app.settings.theme = theme
    this.#markStateDirty()
  }

  async setLanguage(language: string) {
    const selected = UI_LANGUAGES.find((known) => known === language)
    if (!selected) return
    this.app.settings.language = selected
    await saveUiLanguage(selected)
    this.#markStateDirty()
  }

  /**
   * Switches reasoning between trace cards and plain muted text, mirroring the TUI's /thinking
   * toggle.
   */
  async setThinkingVisible(visible: boolean) {
    await saveThinkingVisible(visible)
    this.app.settings.thinkingVisible = visible
    this.#markStateDirty()
  }

  async setLocalThinking(model: string, level: string) {
    if (this.#draining || this.#modelState !== "ready")
      throw new Error("Wait until the local model is ready.")
    await this.app.setLocalThinking(model, level)
    this.#markStateDirty()
  }

  /** Applies and persists the interactive permission mode for subsequent tool calls. */
  async setPermissionMode(mode: "ask" | "auto") {
    await savePermissionMode(mode)
    this.app.permissionMode = mode
    this.app.settings.permissions = {
      defaultMode: mode,
      rules: [...(this.app.settings.permissions?.rules ?? [])],
    }
    this.#markStateDirty()
  }

  /**
   * Toggles Fast serving for the selected hosted model, mirroring the TUI's /fast command: the
   * model is re-selected on its fast or standard path and the preference is persisted per base
   * model id.
   */
  async setFastServing(fast: boolean): Promise<ModelSelectResult> {
    if (this.#deleting || this.app.conversation.busy || this.#draining) {
      return { ok: false, reason: "Finish the current work before changing Fast serving." }
    }
    if (this.app.models.selectedProvider !== "fireworks" || !this.app.models.selectedId) {
      return { ok: false, reason: NO_FAST_SERVING }
    }
    this.#selecting += 1
    try {
      const selection = await this.app.models.enqueueSelection(
        async (signal): Promise<ModelSelectResult> => {
          const selectedId = this.app.models.selectedId
          if (!selectedId || this.app.models.selectedProvider !== "fireworks")
            return { ok: false, reason: NO_FAST_SERVING }
          if (isFastFireworksModel(selectedId) === fast) return { ok: true }
          if (signal.aborted || this.#disposed) return { ok: false, reason: SUPERSEDED }
          const baseId = baseFireworksModelId(selectedId) ?? selectedId
          const hostedRow = (items: ModelPickerItem[]) =>
            items.find(
              (entry): entry is FireworksPickerChoice =>
                entry.kind === "model" && entry.provider === "fireworks" && entry.id === baseId,
            )
          let item = hostedRow(this.#lastPickerItems ?? [])
          if (!item?.fastId) {
            try {
              item = hostedRow(await this.listModels())
            } catch (error) {
              return { ok: false, reason: errorMessage(error) }
            }
          }
          if (!item?.fastId) return { ok: false, reason: NO_FAST_SERVING }
          const result = await this.#prepareModelSelection(
            fireworksServingModel(item, fast),
            item.id,
            signal,
            async (serving) => {
              if (serving.provider !== "fireworks")
                throw new Error("Fast serving only applies to hosted models.")
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
        },
      )
      return selection ?? { ok: false, reason: SUPERSEDED }
    } finally {
      this.#selecting -= 1
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /**
   * Validates and activates a Fireworks API key, mirroring the TUI's /settings hosted flow: the key
   * is checked against the hosted catalog before it is saved, and a live hosted client is rebuilt
   * onto the new key.
   */
  async setFireworksApiKey(apiKey: string): Promise<ModelSelectResult> {
    const key = apiKey.trim()
    if (!key) return { ok: false, reason: "Fireworks API key is required." }
    try {
      const models = await (this.options.listToolCapableModels ?? listToolCapableModels)(key, {})
      if (models.length === 0) {
        return {
          ok: false,
          reason: "The hosted provider returned no public models with tool support.",
        }
      }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
    await saveFireworksApiKey(key)
    this.app.fireworksApiKey = key
    if (this.app.models.selectedProvider === "fireworks" && this.app.models.selectedId) {
      this.app.models.client = new FireworksClient({
        apiKey: key,
        model: this.app.models.selectedId,
      })
      // A saved hosted model waiting on a key becomes chat-ready the moment the key lands.
      this.#modelState = "ready"
      this.#modelError = undefined
    }
    this.#markStateDirty()
    return { ok: true }
  }

  /** Shares discovery, persistence, and active-client refresh with terminal setup. */
  async connectLocalServers(input: LocalServerInputs): Promise<ModelSelectResult> {
    if (this.#deleting || this.app.conversation.busy || this.#draining) {
      return { ok: false, reason: "Finish the current work before changing local servers." }
    }
    this.#selecting += 1
    try {
      await this.app.connectLocalServers(input, {
        discoverPair: this.options.discoverPair,
        discoverOmlx: this.options.discoverOmlx,
      })
      const provider = this.app.models.selectedProvider
      if (provider === "pair" || provider === "omlx") {
        this.#modelState = this.app.models.client ? "ready" : "failed"
        this.#modelError = this.app.models.client
          ? undefined
          : "The local model server for the selected model is no longer available. Reconnect or choose another model."
      }
      this.#lastPickerItems = undefined
      this.#markStateDirty()
      return { ok: true }
    } catch (error) {
      if (this.app.models.selectedId && !this.app.models.client) {
        this.#modelState = "failed"
        this.#modelError = errorMessage(error)
        this.#markStateDirty()
      }
      return { ok: false, reason: errorMessage(error) }
    } finally {
      this.#selecting -= 1
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /**
   * Deletes a downloaded local model from the model catalog, mirroring the TUI's /settings
   * delete-model flow including the rollback. Holds the selection counter for the entire operation
   * — the same exclusion a model switch gets — so a prompt cannot be admitted, and another
   * selection cannot commit and then be cleared, mid-delete.
   */
  async deleteLocalModel(modelId: string): Promise<ModelSelectResult> {
    if (this.#deleting || this.app.conversation.busy || this.#draining || this.#selecting > 0) {
      return { ok: false, reason: "Finish the current work before deleting a model." }
    }
    const spec = findLocalModel(modelId)
    if (!spec) return { ok: false, reason: "That model is not in the local catalog." }

    this.#deleting = true
    this.#selecting += 1
    try {
      await this.cancelModelSelection()
      const active =
        this.app.models.selectedProvider === "local" && this.app.models.selectedId === spec.id
      const previousActive = this.app.models.activeLocal
      let settingsCleared = false
      try {
        const downloaded = await listDownloadedLocalModels()
        const deletingLast = downloaded.length === 1 && downloaded[0].id === spec.id
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
            await saveSelectedModel(catalogModelFromSpec(spec, previousActive?.contextLength))
            if (previousActive) await this.app.models.restorePrevious(previousActive)
          } catch (rollbackError) {
            failure = new AggregateError(
              [error, rollbackError],
              `${errorMessage(error)} The active local model could not be restored.`,
            )
          }
        }
        return {
          ok: false,
          reason: `Could not delete ${spec.displayName}: ${errorMessage(failure)}`,
        }
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
      return { ok: true }
    } finally {
      this.#deleting = false
      this.#selecting -= 1
      if (this.#selecting === 0) this.#ensureDrain()
    }
  }

  /** Session-only debug mode; applies from the next turn, matching the TUI. */
  setDebugMode(enabled: boolean) {
    this.#debug = enabled
    this.#markStateDirty()
  }

  async cancelModelSelection() {
    this.app.models.cancelSelection()
    await this.app.models.waitForSelection()
    // A selection aborted before it started never ran its own cleanup; clear any stale progress
    // row.
    if (this.#modelLoad?.status.kind === "progress") this.#setModelLoad(undefined)
    // Cancelling the saved model's startup leaves nothing to serve prompts: surface it as a failed
    // start so the picker's active row becomes a real retry instead of a dead shortcut.
    if (!this.app.models.client && this.#modelState === "starting") {
      this.#modelState = "failed"
      this.#modelError = "The model start was cancelled."
      this.#markStateDirty()
    }
  }

  /**
   * The full transcript of one delegated run for the trace view; an empty list when the run is
   * gone.
   */
  getSubagentTrace(toolCallId: string): TranscriptEntry[] {
    const trace = this.app.subagents.get(toolCallId)
    return trace ? [...trace.transcript.entries] : []
  }

  /** Persists the delegated-runs rail preference, mirroring the TUI's subagent panel setting. */
  async setAgentsPanelVisible(visible: boolean) {
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
    this.#unsubscribe()
    await this.#flushing
    await this.app.shutdown()
  }

  /**
   * The live application for the current workspace; re-pointed by switchWorkspace. Exposed for
   * tests.
   */
  get app(): Application {
    return this.#app
  }

  /**
   * Runs a prompt and then drains the shared follow-up queue, mirroring the TUI: every settled turn
   * (completed, interrupted, or failed) hands the next queued prompt back to the conversation.
   * Resolves when the first prompt leaves the busy loop; `signalAdmitted` fires as soon as that
   * prompt is durably recorded.
   */
  async #drive(
    first: UserChatMessage | QueuedPrompt,
    signalAdmitted?: () => void,
  ): Promise<"settled"> {
    let input: UserChatMessage | QueuedPrompt = first
    let hooks = this.#hooks(signalAdmitted)
    this.#draining = true
    try {
      for (;;) {
        const result = await this.app.conversation.start(input, hooks)
        this.#phase = "idle"
        void this.#refreshStats()
        const session = this.app.sessions.current
        if (result.status === "complete" && session && !this.app.sessions.title) {
          void this.app.sessions.generateTitle(session).then(() => this.#markStateDirty())
        }
        this.#markStateDirty()
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
   * Starts a drain-only driver when a queued follow-up has no live loop to pick it up — its session
   * admission may have completed after the previous turn's driver already exited. The flag
   * transition and takeQueued() are synchronous with respect to the exiting loop's finally, so a
   * follow-up cannot be both missed and undriven.
   */
  #ensureDrain() {
    // A model switch in flight parks queued work: preparation may stop the server the next turn
    // would run on. selectModel re-triggers the drain when its last open selection settles.
    if (this.#draining || this.#disposed || this.#rendererGone || this.#selecting > 0) return
    // Nothing can serve the queue without a usable client — after the active model is deleted, or
    // after a failed start. Keep the queue parked; a selection's settle re-triggers the drain once
    // a model is ready.
    if (!this.app.models.client) return
    const queued = this.app.conversation.takeQueued()
    if (queued) void this.#drive(queued)
  }

  #hooks(onReady?: () => void): ConversationHooks {
    const dirty = () => this.#markStateDirty()
    return {
      // Transcript mutations reach the renderer through the store subscription; the sink only
      // carries status.
      sink: {
        renderTranscript: dirty,
        renderSubagents: dirty,
        setPhase: (phase) => {
          this.#phase = phase
          this.#markStateDirty()
        },
        startBusy: dirty,
        stopBusy: dirty,
      },
      debug: this.#debug,
      onReady,
      onContext: dirty,
      onDiff: (added, removed) => {
        this.app.sessions.addDiff(added, removed)
        this.#markStateDirty()
      },
      onPermissionRequest: (request) => {
        // A previous request that never resolved (e.g. an interrupted turn) is denied before a new
        // one is shown.
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
      },
      onCompletion: dirty,
    }
  }

  /**
   * Starts the saved selection through the model host's selection queue: a model picked while the
   * saved one is still loading supersedes startup, so its late commit can never reactivate the old
   * model over the new one.
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
        const name =
          (selectedId && findLocalModel(selectedId)?.displayName) ?? selectedId ?? "model"
        this.app.transcript.addAssistantMessage(`Could not start ${name}: ${this.#modelError}`)
      }
      this.#markStateDirty()
      this.#flushNow()
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
    if (change.op === "reset") this.#conversationVersion += 1
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

  /**
   * Compacts queued store mutations into renderer ops and sends them. A reset invalidates every
   * change before it.
   */
  async #deliver(changes: TranscriptChange[], sendState: boolean) {
    let lastReset = -1
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      if (changes[index].op === "reset") {
        lastReset = index
        break
      }
    }
    const ops: TranscriptPatchOp[] = []
    if (lastReset !== -1) ops.push({ op: "reset", entries: [...this.app.transcript.entries] })
    const upserted = new Set<number>()
    for (const change of changes.slice(lastReset + 1)) {
      if (change.op === "upsert") {
        const entry = this.app.transcript.entries.find((entry) => entry.id === change.id)
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

    // A session reset and its metadata are one display transaction. Keep the old view intact while
    // history is scanned; a standalone reset would show Home with the previous session's title and
    // coworkers.
    if (lastReset !== -1) {
      const revision = ++this.#revision
      const status = await this.#status()
      this.options.send({ type: "status", revision, status, ops })
      return
    }
    if (ops.length > 0) this.options.send({ type: "transcript", revision: ++this.#revision, ops })
    if (sendState) {
      const revision = ++this.#revision
      const status = await this.#status()
      this.options.send({ type: "status", revision, status })
    }
  }

  async #status(): Promise<DesktopStatus> {
    const app = this.app
    // The cached global session scan; invalidated by every operation that creates, opens, or
    // removes one.
    if (this.#sessionsCache === undefined) {
      const pending = listGlobalSessionPickerItems({
        activeId: app.sessions.current?.id,
        activeDirName: app.sessions.currentDirName,
        seeds: [app.cwd],
      })
      this.#sessionsCache = pending
      void pending.catch(() => {
        if (this.#sessionsCache === pending) this.#sessionsCache = undefined
      })
    }
    // Fast serving availability for the selected hosted model, resolved without a catalog fetch.
    const fastServing = { available: false, enabled: false }
    if (app.models.selectedProvider === "fireworks" && app.models.selectedId) {
      const selectedId = app.models.selectedId
      const baseId = baseFireworksModelId(selectedId) ?? selectedId
      fastServing.enabled = isFastFireworksModel(selectedId)
      fastServing.available =
        fastServing.enabled ||
        app.settings.modelFastId !== undefined ||
        app.settings.fastServingModels?.includes(baseId) === true ||
        this.#lastPickerItems?.some(
          (entry) =>
            entry.kind === "model" &&
            entry.provider === "fireworks" &&
            entry.id === baseId &&
            Boolean(entry.fastId),
        ) === true
    }
    return {
      busy: app.conversation.busy || this.#draining,
      phase: this.#phase,
      model: app.models.selectedId
        ? {
            id: app.models.selectedId,
            provider: app.models.selectedProvider ?? "fireworks",
            supportsImageInput: app.models.supportsImageInput === true,
            ...(app.settings.modelDisplayName
              ? { displayName: app.settings.modelDisplayName }
              : {}),
          }
        : null,
      modelState: this.#modelState,
      modelError: this.#modelError,
      session: app.sessions.current
        ? { id: app.sessions.current.id, title: app.sessions.activeLabel() }
        : null,
      artifact: app.artifacts.metadata ?? null,
      needsWorkspace: this.#pendingWorkspace !== undefined,
      workspace: { label: formatWorkspaceLabel(app.cwd), path: app.cwd },
      contextTokens: app.contextTokens(),
      contextLimit: app.models.autoCompactAtTokens,
      diffs: app.sessions.diffs,
      permission: this.#pending?.request ?? null,
      stats: this.#stats,
      modelLoad: this.#modelLoad ?? null,
      agentsPanelVisible: app.settings.subagentPanelVisible ?? true,
      theme: app.settings.theme ?? "default",
      language: app.settings.language ?? "system",
      thinkingVisible: app.settings.thinkingVisible ?? false,
      localThinking: app.models.thinkingState(),
      permissionMode: app.permissionMode,
      fastServing,
      hostedConfigured: Boolean(app.fireworksApiKey),
      pairConfigured: Boolean(app.pairEndpoints.ollama || app.pairEndpoints.lmStudio),
      pairEndpoints: { ...app.pairEndpoints },
      omlx: app.models.omlx
        ? { baseURL: app.models.omlx.baseURL, hasApiKey: Boolean(app.models.omlx.apiKey) }
        : null,
      debug: this.#debug,
      update: this.#update,
      subagents: app.subagents.all.map((trace) => ({
        toolCallId: trace.toolCallId,
        title: trace.title,
        status: trace.status,
        ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
        tools: trace.transcript.entries.filter((entry) => entry.kind === "tool").length,
      })),
      // Capture all live fields before yielding so a slow history scan cannot mix two sessions'
      // metadata.
      sessions: await this.#sessionsCache,
    }
  }
}

/**
 * Storage identity for a session row: its dir under the shared sessions root, validated against
 * traversal.
 */
function sessionDir(dirName: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid session directory")
  return join(sessionRootDirectory(), dirName)
}

function selectResult(result: "noop" | "loaded" | "locked"): SessionOpResult {
  if (result === "locked")
    return { ok: false, reason: "That session is open in another Otis window." }
  if (result === "noop")
    return { ok: false, reason: "Finish the current work before switching sessions." }
  return { ok: true }
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
