import type { RuntimeSummary, SubagentSummary } from "../app/application.js"
import type { PendingPermission, TurnPhase, TurnSpeed } from "../app/conversation.js"
import type { GlobalSessionPickerItem, RecentArtifact } from "../app/global-sessions.js"
import type { LocalServerInputs } from "../app/local-servers.js"
import type { ModelState } from "../app/models.js"
import type { TranscriptEntry } from "../app/transcript.js"
import type { ArtifactMetadata, ArtifactPayload, ArtifactReference } from "../artifacts/types.js"
import type { LocalThinkingSelection, LocalThinkingState } from "../inference/local-thinking.js"
import type { ModelPickerItem, ModelPickerStatus } from "../inference/picker-catalog.js"
import type { ModelProvider } from "../inference/types.js"
import type { ThemeName, UiLanguage } from "../local/settings.js"
import type { PermissionMode } from "../permissions/policy.js"
import type { SkillsSummary } from "../skills/catalog.js"

export type { RuntimeSummary, SubagentSummary } from "../app/application.js"
export type { PendingPermission, TurnPhase, TurnSpeed } from "../app/conversation.js"
export type { RecentArtifact } from "../app/global-sessions.js"
export type { ModelState } from "../app/models.js"
export type { ThemeName, UiLanguage } from "../local/settings.js"
export type { PermissionMode } from "../permissions/policy.js"

import type { LocalStats } from "../local/stats.js"

export const DESKTOP_CHANNELS = {
  getSnapshot: "desktop:get-snapshot",
  getArtifact: "desktop:get-artifact",
  openArtifact: "desktop:open-artifact",
  closeArtifact: "desktop:close-artifact",
  saveArtifact: "desktop:save-artifact",
  sendPrompt: "desktop:send-prompt",
  stop: "desktop:stop",
  respondToPermission: "desktop:respond-to-permission",
  selectSession: "desktop:select-session",
  focusSession: "desktop:focus-session",
  openPane: "desktop:open-pane",
  closePane: "desktop:close-pane",
  soloPane: "desktop:solo-pane",
  replacePane: "desktop:replace-pane",
  searchSessions: "desktop:search-sessions",
  startNewSession: "desktop:start-new-session",
  openSessionAt: "desktop:open-session-at",
  openWorkspace: "desktop:open-workspace",
  locateWorkspace: "desktop:locate-workspace",
  pickWorkspaceFolder: "desktop:pick-workspace-folder",
  registerWorkspace: "desktop:register-workspace",
  refreshSessions: "desktop:refresh-sessions",
  deleteSession: "desktop:delete-session",
  listModels: "desktop:list-models",
  selectModel: "desktop:select-model",
  cancelModelSelection: "desktop:cancel-model-selection",
  getSubagentTrace: "desktop:subagent-trace",
  setAgentsPanelVisible: "desktop:set-agents-panel-visible",
  setWorkspacePanelWidth: "desktop:set-workspace-panel-width",
  setTheme: "desktop:set-theme",
  setLanguage: "desktop:set-language",
  setThinkingVisible: "desktop:set-thinking-visible",
  setNotifyOnCompletion: "desktop:set-notify-on-completion",
  setLocalThinking: "desktop:set-local-thinking",
  setPermissionMode: "desktop:set-permission-mode",
  setFastServing: "desktop:set-fast-serving",
  openFireworksKeyPage: "desktop:open-fireworks-key-page",
  setFireworksApiKey: "desktop:set-fireworks-api-key",
  connectLocalServers: "desktop:connect-local-servers",
  deleteLocalModel: "desktop:delete-local-model",
  listSkills: "desktop:list-skills",
  installSkills: "desktop:install-skills",
  updateSkills: "desktop:update-skills",
  removeSkills: "desktop:remove-skills",
  setDebugMode: "desktop:set-debug-mode",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  getWindowState: "desktop:get-window-state",
  windowState: "desktop:window-state",
  event: "desktop:event",
} as const

/** Update lifecycle shared by automatic checks, Settings, and the restart affordance. */
export type DesktopUpdateState =
  | { status: "idle" | "checking" | "current" | "unavailable" }
  | { status: "downloading" | "ready"; version: string }
  | { status: "error"; message: string }

/**
 * The mutable application state outside the transcript. Sent whole on every change; it is small.
 */
export type DesktopStatus = {
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
  session: { id: string; title: string } | null
  /**
   * Every document open in Canvas across the sessions on screen, in opening order; a session's
   * documents leave with it and return with it. Contents are fetched once per tab revision.
   */
  artifacts: CanvasTab[]
  /**
   * The active session's working folder is unknown or gone; locate it before agent work continues.
   */
  needsWorkspace: boolean
  /** Global history: sessions from every registered workspace, recency-ordered. */
  sessions: GlobalSessionPickerItem[]
  /** The newest Canvas documents across every workspace, scanned together with the sessions. */
  recentArtifacts: RecentArtifact[]
  /** The workspace this window is working in. */
  workspace: { label: string; path: string }
  contextTokens: number | undefined
  contextLimit: number
  diffs: { added: number; removed: number }
  /** The approval request at the head of the shared queue, from any open session. */
  permission: PendingPermission | null
  /** Approval requests waiting behind `permission`. */
  permissionQueue: number
  /** Local usage statistics; undefined until the first scan completes. */
  stats: LocalStats | undefined
  /**
   * Progress or terminal error of a model load in flight, keyed by picker item id. Progress entries
   * clear when the load completes; error entries stay until the next selection attempt so an open
   * picker can show the failure.
   */
  modelLoad: { modelId: string; status: ModelPickerStatus } | null
  /** The session's delegated runs, oldest first. */
  subagents: SubagentSummary[]
  /** Every session open in this window; exactly one is focused. */
  runtimes: RuntimeSummary[]
  /** Open sessions mid-turn other than the focused one. */
  working: number
  /** The open sessions on screen, in display order; the focused one is among them. */
  panes: number[]
  /** How two panes divide the column; three or four fill a grid. */
  paneAxis: PaneAxis
  /** The delegated-runs rail preference; persisted as subagentPanelVisible in local settings. */
  agentsPanelVisible: boolean
  /** The workspace panel width the user last dragged to; undefined follows the responsive default. */
  workspacePanelWidth: number | undefined
  /** The active color theme; persisted in local settings. */
  theme: ThemeName
  /** Desktop interface language; system follows the operating system locale. */
  language: UiLanguage
  /**
   * Reasoning renders as trace cards when on; plain muted text when off. Persisted in local
   * settings.
   */
  thinkingVisible: boolean
  /** A system notification when a session finishes while Otis is not the frontmost app. */
  notifyOnCompletion: boolean
  localThinking: LocalThinkingState | null
  /** Permission behavior for mutating tools. Interactive controls offer ask and auto. */
  permissionMode: PermissionMode
  /**
   * Fast serving for the selected hosted model: whether it has a fast path, and whether that path
   * is active.
   */
  fastServing: { available: boolean; enabled: boolean }
  /** A Fireworks API key is configured. The key itself is never sent to the renderer. */
  hostedConfigured: boolean
  /** At least one NVIDIA PAIR endpoint is configured. */
  pairConfigured: boolean
  /** The saved PAIR endpoint addresses (loopback URLs), for prefilling the connect form. */
  pairEndpoints: { ollama?: string; lmStudio?: string }
  omlx?: { baseURL: string; hasApiKey: boolean } | null
  /** Session-only debug mode, mirroring the TUI's /debug toggle; applies from the next turn. */
  debug: boolean
  update: DesktopUpdateState
}

/** The edge a session is dropped on: left and top put it first, right and bottom last. */
export type PaneSide = "left" | "right" | "top" | "bottom"
/** Where a dropped session lands: a side of the ones on screen, or a card's place. */
export type PaneDrop = { side: PaneSide } | { replace: number }
export type PaneAxis = "row" | "column"
/** Sessions on screen at once; each is a live virtualized transcript. */
export const MAX_PANES = 4

/** One Canvas tab: a session's open document and the moment it last took the view. */
export type CanvasTab = { runtime: number; artifact: ArtifactMetadata; activated: number }

export type DesktopSnapshot = DesktopStatus & {
  platform: NodeJS.Platform
  version: string
  entries: TranscriptEntry[]
  /** The transcripts of the other sessions on screen, by runtime id. */
  transcripts: Record<number, TranscriptEntry[]>
  revision: number
}

export type TranscriptPatchOp =
  | { op: "reset"; entries: TranscriptEntry[] }
  | { op: "upsert"; entry: TranscriptEntry }
  | { op: "remove"; id: number }

/**
 * Ordered updates from the main process. Every event carries the shared revision counter so a
 * renderer that reloaded can discard anything it already received in its snapshot. Status events
 * can include transcript operations so session resets update content and metadata together.
 */
/** Patch ops for one of the other sessions on screen. */
export type PaneOps = { runtime: number; ops: TranscriptPatchOp[] }

/**
 * `ops` patch the focused session's transcript and `panes` the others on screen. When a status
 * moves focus, lists follow their sessions first; a session not on screen before arrives whole in
 * the same event's `ops`.
 */
export type DesktopEvent =
  | { type: "transcript"; revision: number; ops?: TranscriptPatchOp[]; panes?: PaneOps[] }
  | {
      type: "status"
      revision: number
      status: DesktopStatus
      ops?: TranscriptPatchOp[]
      panes?: PaneOps[]
    }

export type SendPromptResult =
  | { accepted: true; delivery: "started" | "steered" | "queued" }
  | { accepted: false; reason: string }

/**
 * Raw local file selected by the renderer. The main process validates and converts it before
 * session admission.
 */
export type DesktopAttachmentInput = {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export type SessionOpResult = { ok: true } | { ok: false; reason: string }

export type { SkillSummary, SkillsSummary } from "../skills/catalog.js"

/**
 * A preview fetch: the payload for a live revision, a stale marker the renderer ignores, or a
 * reason shown verbatim.
 */
export type ArtifactResult =
  | { ok: true; payload: ArtifactPayload }
  | { ok: false; reason: string; stale?: boolean }

export type ModelSelectResult = { ok: true } | { ok: false; reason: string }

export type DesktopWindowState = { fullscreen: boolean }

/** The API surface exposed to the renderer through the preload bridge. */
export type DesktopApi = {
  getSnapshot(): Promise<DesktopSnapshot>
  /** A tab's payload at the given revision; stale once the tab moved on. */
  getArtifact(runtime: number, id: string, revision: number): Promise<ArtifactResult>
  /** Opens a document in Canvas as the given session's tab; the focused session by default. */
  openArtifact(
    reference: ArtifactReference,
    version?: number,
    runtime?: number,
  ): Promise<SessionOpResult>
  closeArtifact(runtime: number, id: string): Promise<void>
  saveArtifact(runtime: number, id: string, revision: number): Promise<SessionOpResult>
  getWindowState(): Promise<DesktopWindowState>
  sendPrompt(
    text: string,
    attachments?: readonly DesktopAttachmentInput[],
  ): Promise<SendPromptResult>
  stop(): Promise<void>
  respondToPermission(id: number, allow: boolean): Promise<void>
  /** Opens a session in place, or where it was dropped. */
  selectSession(id: string, dirName?: string, at?: PaneDrop): Promise<SessionOpResult>
  /** Shows a session already open in this window, by its runtime id from `runtimes`. */
  focusSession(runtime: number): Promise<void>
  /** Shows an open session on that side of the ones on screen, up to MAX_PANES. */
  openPane(runtime: number, side: PaneSide): Promise<void>
  /** Takes a session off screen; the last one stays. */
  closePane(runtime: number): Promise<void>
  /** Keeps only that session on screen, and makes it the active one. */
  soloPane(runtime: number): Promise<void>
  /** Puts a session in another's place on screen; two already on screen trade places. */
  replacePane(target: number, runtime: number): Promise<void>
  /** Title-first session search for the command palette; content matches carry a snippet. */
  searchSessions(query: string): Promise<GlobalSessionPickerItem[]>
  startNewSession(): Promise<SessionOpResult>
  deleteSession(id: string, dirName?: string): Promise<SessionOpResult>
  /**
   * Recomputes the global session list; the palette calls this when it opens so external (TUI)
   * sessions appear.
   */
  refreshSessions(): Promise<void>
  /** The newest Canvas documents published across every workspace, for the home screen. */
  /**
   * Opens a session from global history, switching workspace first when it lives elsewhere.
   * dirName pins the session's storage identity so a relocated or duplicate id can't resolve to a
   * different conversation.
   */
  openSessionAt(
    workspacePath: string,
    sessionId: string,
    dirName?: string,
  ): Promise<SessionOpResult>
  /** Switches the window to another workspace (validated, refused during active work). */
  openWorkspace(path: string): Promise<SessionOpResult>
  /** Locates the working folder for a read-only pending session and completes its recovery. */
  locateWorkspace(path: string): Promise<SessionOpResult>
  /** Native folder picker; undefined when cancelled. */
  pickWorkspaceFolder(): Promise<string | undefined>
  /**
   * "Locate workspace": registers the folder for a session dir that predates workspace
   * registration.
   */
  registerWorkspace(dirName: string, path: string): Promise<SessionOpResult>
  /**
   * The picker catalog for this machine: local fits, saved PAIR endpoints, and the verified hosted
   * list.
   */
  listModels(): Promise<ModelPickerItem[]>
  /**
   * Selects a picker item, downloading and loading a managed local model when needed. `id` is the
   * item id, or the selectionKey for PAIR entries whose plain ids collide across engines. Resolves
   * when the switch finishes.
   */
  selectModel(id: string): Promise<ModelSelectResult>
  /** Cancels an in-flight model selection; a completed or absent selection is a no-op. */
  cancelModelSelection(): Promise<void>
  /** The full transcript of one delegated run, for the trace view. Empty when the run is gone. */
  getSubagentTrace(toolCallId: string): Promise<TranscriptEntry[]>
  /** Shows or hides the delegated-runs rail; persisted across launches. */
  setAgentsPanelVisible(visible: boolean): Promise<void>
  /** Remembers the dragged workspace panel width; undefined restores the responsive default. */
  setWorkspacePanelWidth(width: number | undefined): Promise<void>
  /** Applies and persists a color theme. Unknown theme names are ignored. */
  setTheme(theme: ThemeName): Promise<void>
  /** Applies and persists the desktop interface language. */
  setLanguage(language: UiLanguage): Promise<void>
  /** Shows thinking as trace cards or as plain muted text; persisted in local settings. */
  setThinkingVisible(visible: boolean): Promise<void>
  setNotifyOnCompletion(enabled: boolean): Promise<void>
  setLocalThinking(model: string, level: LocalThinkingSelection): Promise<void>
  /** Persists the permission behavior used by subsequent tool calls. */
  setPermissionMode(mode: "ask" | "auto"): Promise<void>
  /**
   * Toggles Fast serving for the selected hosted model, re-selecting it on the fast or standard
   * path.
   */
  setFastServing(fast: boolean): Promise<ModelSelectResult>
  /** Opens https://app.fireworks.ai/api-keys in the system browser. */
  openFireworksKeyPage(): Promise<void>
  /** Validates a Fireworks API key against the hosted catalog, then persists and activates it. */
  setFireworksApiKey(apiKey: string): Promise<ModelSelectResult>
  /** Validates, probes, and persists NVIDIA PAIR endpoints, keeping only the ones that respond. */
  connectLocalServers(endpoints: LocalServerInputs): Promise<ModelSelectResult>
  /**
   * Deletes a downloaded local model from the model catalog, clearing the selection first when it
   * is active.
   */
  deleteLocalModel(id: string): Promise<ModelSelectResult>
  /** Rereads the skills on disk and lists them with the Git collections Otis manages. */
  listSkills(): Promise<SkillsSummary>
  /** Installs a Git collection's skills; the agent has them from its next turn. */
  installSkills(url: string): Promise<SessionOpResult>
  /** Fast-forwards a collection. */
  updateSkills(id: string): Promise<SessionOpResult>
  /** Removes a collection and the skills it activated. */
  removeSkills(id: string): Promise<SessionOpResult>
  /** Session-only debug mode; applies from the next turn. */
  setDebugMode(enabled: boolean): Promise<void>
  /** Checks the release feed; progress and results arrive through the status stream. */
  checkForUpdates(): Promise<void>
  /** Restarts into the downloaded update. No-op when no update is ready. */
  installUpdate(): Promise<void>
  subscribeWindowState(listener: (state: DesktopWindowState) => void): () => void
  subscribe(listener: (event: DesktopEvent) => void): () => void
}
