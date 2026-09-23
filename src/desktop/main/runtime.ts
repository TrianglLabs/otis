import { stat } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import {
  Application,
  formatWorkspaceLabel,
  NO_FAST_SERVING,
  SELECTION_SUPERSEDED,
} from "../../app/application.js"
import {
  type GlobalHistory,
  type GlobalSessionPickerItem,
  listGlobalHistory,
  searchGlobalSessionPickerItems,
} from "../../app/global-sessions.js"
import type { LocalServerInputs } from "../../app/local-servers.js"
import { isAbortError } from "../../app/models.js"
import { SESSION_REASONS } from "../../app/sessions.js"
import type { TranscriptChange, TranscriptEntry } from "../../app/transcript.js"
import type { ArtifactReference } from "../../artifacts/types.js"
import { createAttachment } from "../../inference/attachments.js"
import type { listToolCapableModels } from "../../inference/catalog.js"
import { errorMessage } from "../../inference/errors.js"
import { findLocalModel } from "../../inference/local-catalog.js"
import { discoverOmlxModels } from "../../inference/omlx.js"
import { discoverPairModels, type PairDiscovery } from "../../inference/pair.js"
import {
  type FireworksPickerChoice,
  listModelPickerItems,
  type ModelPickerChoice,
  type ModelPickerItem,
} from "../../inference/picker-catalog.js"
import { baseFireworksModelId } from "../../inference/serving-path.js"
import {
  type AttachmentContentPart,
  type FireworksModel,
  SUPPORTED_IMAGE_EXTENSIONS,
  type UserChatMessage,
} from "../../inference/types.js"
import {
  isThemeName,
  saveLastWorkspace,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  saveUiLanguage,
  saveWorkspacePanelWidth,
  UI_LANGUAGES,
} from "../../local/settings.js"
import { calculateLocalStats } from "../../local/stats.js"
import {
  defaultSessionDirectory,
  sessionFile,
  sessionRootDirectory,
} from "../../storage/session-files.js"
import { readWorkspacePath, registerWorkspacePath } from "../../storage/workspace-registry.js"
import type {
  ArtifactResult,
  DesktopAttachmentInput,
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  ModelSelectResult,
  SendPromptResult,
  SessionOpResult,
  TranscriptPatchOp,
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

/** Home-screen document rows. */
const RECENT_ARTIFACTS = 3

const RESTARTING = "Otis is restarting to finish an update."
const SWITCHING = "Switching workspaces — try again in a moment."
const LOCATING = "Locating the working folder — try again in a moment."
/** Never shown: a live renderer resets the flag before it submits. Parks the queue meanwhile. */
const RENDERER_GONE = "The window is reloading."

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
  #historyCache: Promise<GlobalHistory> | undefined
  #stats: DesktopStatus["stats"]
  #update: DesktopStatus["update"] = { status: "idle" }
  #queuedChanges: TranscriptChange[] = []
  #stateDirty = false
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #flushing: Promise<void> | undefined
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

  /** Points the runtime at an application and its change stream. */
  #attach(app: Application) {
    this.#app = app
    app.extraGate = () => this.#extraGate()
    app.conversation.debug = this.#debug
    // A backend fallback during a local model start reaches the transcript like a start failure.
    app.models.onNotice = (message) => {
      if (!this.#disposed) app.transcript.addAssistantMessage(message)
    }
    // Transcript mutations reach the renderer as patch ops; everything else is status.
    const events = app.subscribe((event) => {
      if (event.type === "transcript") this.#onTranscriptChange(event.change)
      else if (event.type === "settled") void this.#refreshStats()
      else if (event.type === "busy" && !event.busy) {
        this.#historyCache = undefined
        this.#markStateDirty()
        this.#flushNow()
      } else this.#markStateDirty()
    })
    const artifacts = app.artifacts.subscribe(() => this.#markStateDirty())
    this.#unsubscribe = () => {
      events()
      artifacts()
    }
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

  async getArtifact(revision: number): Promise<ArtifactResult> {
    try {
      const payload = await this.app.artifacts.load(revision)
      return payload
        ? { ok: true, payload }
        : { ok: false, stale: true, reason: "This preview changed." }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
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
    // A live renderer sending a prompt un-gates the queue after a renderer crash.
    this.#rendererGone = false
    const rejection = this.app.admissionGate()
    if (rejection) return { accepted: false, reason: rejection }
    const app = this.app
    const client = app.models.client
    const conversationVersion = this.#conversationVersion
    if (!text.trim() && inputs.length === 0)
      return { accepted: false, reason: "The prompt is empty." }
    if (text.length > MAX_PROMPT_CHARS)
      return { accepted: false, reason: "The prompt is too long." }
    const claimsImage = inputs.some(
      (input) =>
        input.mimeType.toLowerCase().startsWith("image/") ||
        (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(
          extname(input.name).toLowerCase(),
        ),
    )
    let message: UserChatMessage
    try {
      // An image the model cannot take is refused before its bytes are parsed.
      if (claimsImage) await app.ensureImageSupport()
      const attachments: AttachmentContentPart[] = []
      for (const input of inputs) {
        attachments.push(
          await createAttachment(input.bytes, input.name, input.mimeType || undefined),
        )
      }
      message = await app.buildPrompt(text, attachments)
    } catch (error) {
      return { accepted: false, reason: errorMessage(error) }
    }
    // Parsing can yield while a session, workspace, model, or renderer changes. Admission must
    // still target the conversation and model for which the user submitted these attachments.
    const changed = app.admissionGate()
    if (changed) return { accepted: false, reason: changed }
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
    try {
      const { delivery } = await app.conversation.submit(message)
      this.#markStateDirty()
      return { accepted: true, delivery }
    } catch (error) {
      return { accepted: false, reason: errorMessage(error) }
    }
  }

  /** The window's own reasons to refuse a prompt or park the queue, ahead of the model's. */
  #extraGate(): string | undefined {
    // Once shutdown starts (update install), the session lock is released and no renderer receives
    // updates.
    if (this.#disposed) return RESTARTING
    if (this.#rendererGone) return RENDERER_GONE
    if (this.#switching) return SWITCHING
    if (this.#pendingWorkspace) return "Locate the working folder to continue this session."
    // A foreign session's read-only restriction is set after its async open; prompts must not slip
    // through first.
    if (this.#sessionSelecting > 0) return "Opening the session — try again in a moment."
    return undefined
  }

  stop() {
    this.app.conversation.stop()
  }

  respondToPermission(id: number, allow: boolean) {
    this.app.conversation.respondToPermission(id, allow)
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
      this.#historyCache = undefined
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
    this.#historyCache = undefined
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
    if (
      this.app.conversation.busy ||
      this.app.models.selecting ||
      this.app.models.load?.status.kind === "progress"
    ) {
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
      this.#historyCache = undefined
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
      this.#historyCache = undefined
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
    this.#historyCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  /** The home screen's recent documents: published Canvas artifacts from every workspace. */
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
    this.#historyCache = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  async deleteSession(sessionId: string, dirName?: string): Promise<SessionOpResult> {
    if (this.#disposed) return { ok: false, reason: RESTARTING }
    if (this.#switching) return { ok: false, reason: SWITCHING }
    if (this.#locating) return { ok: false, reason: LOCATING }
    if (!sessionId) return { ok: false, reason: "Invalid session id." }
    const result = await this.app.sessions.delete(sessionId, this.#storageFor(dirName))
    if (result !== "deleted") return { ok: false, reason: SESSION_REASONS[result] }
    if (this.app.sessions.current === undefined) this.#pendingWorkspace = undefined
    this.#historyCache = undefined
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
      loadStatus: this.app.models.load,
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
   * Switches the selected model. `id` is the picker item id, or the selectionKey for PAIR entries
   * whose plain ids collide across engines; the row comes from the last listing, refreshed only
   * when the renderer's row is unknown to it. The transaction itself, including click ordering
   * and progress on the row, is the application's.
   */
  async selectModel(id: string): Promise<ModelSelectResult> {
    if (!id) return { ok: false, reason: "Invalid model id." }
    const match = (entry: ModelPickerItem): entry is ModelPickerChoice =>
      entry.kind === "model" &&
      ("selectionKey" in entry ? entry.selectionKey === id : entry.id === id)
    let item = this.#lastPickerItems?.find(match)
    if (!item) {
      try {
        item = (await this.listModels()).find(match)
      } catch (error) {
        return { ok: false, reason: errorMessage(error) }
      }
      if (this.#disposed) return { ok: false, reason: SELECTION_SUPERSEDED }
      if (!item) return { ok: false, reason: "That model is no longer in the catalog." }
    }
    return this.app.selectModel(item)
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
    if (this.app.conversation.draining || this.app.models.state !== "ready")
      throw new Error("Wait until the local model is ready.")
    await this.app.setLocalThinking(model, level)
    this.#markStateDirty()
  }

  async setPermissionMode(mode: "ask" | "auto") {
    await this.app.setPermissionMode(mode)
    this.#markStateDirty()
  }

  /** Toggles Fast serving for the selected hosted model; the last listing spares a catalog fetch. */
  async setFastServing(fast: boolean): Promise<ModelSelectResult> {
    const { selectedId, selectedProvider } = this.app.models
    if (selectedProvider !== "fireworks" || !selectedId)
      return { ok: false, reason: NO_FAST_SERVING }
    const baseId = baseFireworksModelId(selectedId) ?? selectedId
    const hostedRow = (items: ModelPickerItem[]) =>
      items.find(
        (entry): entry is FireworksPickerChoice =>
          entry.kind === "model" && entry.provider === "fireworks" && entry.id === baseId,
      )
    let catalog: FireworksModel[] | undefined
    const listed = hostedRow(this.#lastPickerItems ?? [])
    if (listed?.fastId) catalog = [listed]
    else {
      try {
        const row = hostedRow(await this.listModels())
        if (row) catalog = [row]
      } catch (error) {
        return { ok: false, reason: errorMessage(error) }
      }
    }
    return this.app.setFastServing(fast, { catalog })
  }

  /** Validates a Fireworks API key against the hosted catalog, then persists and activates it. */
  async setFireworksApiKey(apiKey: string): Promise<ModelSelectResult> {
    try {
      await this.app.setFireworksApiKey(apiKey, { list: this.options.listToolCapableModels })
      this.#markStateDirty()
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
  }

  /** Shares discovery, persistence, and active-client refresh with terminal setup. */
  async connectLocalServers(input: LocalServerInputs): Promise<ModelSelectResult> {
    if (this.app.conversation.busy) {
      return { ok: false, reason: "Finish the current work before changing local servers." }
    }
    try {
      await this.app.connectLocalServers(input, {
        discoverPair: this.options.discoverPair,
        discoverOmlx: this.options.discoverOmlx,
      })
      this.#lastPickerItems = undefined
      this.#markStateDirty()
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
  }

  /** Deletes a downloaded local model, clearing the selection first when it is active. */
  async deleteLocalModel(modelId: string): Promise<ModelSelectResult> {
    try {
      await this.app.deleteLocalModel(modelId)
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
    this.#lastPickerItems = undefined
    this.#markStateDirty()
    return { ok: true }
  }

  /** Session-only debug mode; applies from the next turn, matching the TUI. */
  setDebugMode(enabled: boolean) {
    this.#debug = enabled
    this.app.conversation.debug = enabled
    this.#markStateDirty()
  }

  cancelModelSelection() {
    return this.app.cancelModelSelection()
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

  async setWorkspacePanelWidth(width: number | undefined) {
    this.app.settings.workspacePanelWidth = width
    await saveWorkspacePanelWidth(width)
    this.#markStateDirty()
  }

  /** The renderer process is gone: cancel active execution and deny any unanswered approval. */
  handleRendererGone() {
    this.#rendererGone = true
    this.app.conversation.stop()
  }

  async shutdown() {
    this.#disposed = true
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    this.app.models.cancelSelection()
    this.app.conversation.stop()
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

  /** Starts the saved selection; a failure that was not superseded is told in the transcript. */
  async #startSavedSelection() {
    if (this.app.models.client || !this.app.models.selectedId) return
    try {
      await this.app.startSavedSelection({ isExiting: () => this.#disposed })
    } catch (error) {
      if (this.#disposed || isAbortError(error)) return
      const selectedId = this.app.models.selectedId
      const name = (selectedId && findLocalModel(selectedId)?.displayName) ?? selectedId ?? "model"
      this.app.transcript.addAssistantMessage(`Could not start ${name}: ${errorMessage(error)}`)
    }
    this.#markStateDirty()
    this.#flushNow()
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
    if (this.#historyCache === undefined) {
      const pending = listGlobalHistory(RECENT_ARTIFACTS, {
        activeId: app.sessions.current?.id,
        activeDirName: app.sessions.currentDirName,
        seeds: [app.cwd],
      })
      this.#historyCache = pending
      void pending.catch(() => {
        if (this.#historyCache === pending) this.#historyCache = undefined
      })
    }
    const status = app.status()
    // The last picker listing also knows Fast availability, without a catalog fetch per status.
    const { selectedId } = app.models
    const baseId = selectedId && (baseFireworksModelId(selectedId) ?? selectedId)
    const fastServing = {
      ...status.fastServing,
      available:
        status.fastServing.available ||
        (app.models.selectedProvider === "fireworks" &&
          this.#lastPickerItems?.some(
            (entry) =>
              entry.kind === "model" &&
              entry.provider === "fireworks" &&
              entry.id === baseId &&
              Boolean(entry.fastId),
          ) === true),
    }
    return {
      ...status,
      fastServing,
      artifact: app.artifacts.metadata ?? null,
      needsWorkspace: this.#pendingWorkspace !== undefined,
      workspace: { label: formatWorkspaceLabel(app.cwd), path: app.cwd },
      stats: this.#stats,
      agentsPanelVisible: app.settings.subagentPanelVisible ?? true,
      workspacePanelWidth: app.settings.workspacePanelWidth,
      theme: app.settings.theme ?? "default",
      language: app.settings.language ?? "system",
      thinkingVisible: app.settings.thinkingVisible ?? false,
      pairConfigured: Boolean(app.pairEndpoints.ollama || app.pairEndpoints.lmStudio),
      debug: this.#debug,
      update: this.#update,
      // Capture all live fields before yielding so a slow history scan cannot mix two sessions'
      // metadata.
      ...(await this.#historyCache.then(({ sessions, artifacts }) => ({
        sessions,
        recentArtifacts: artifacts,
      }))),
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
  return result === "loaded" ? { ok: true } : { ok: false, reason: SESSION_REASONS[result] }
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
