import type { GlobalSessionPickerItem } from "../app/global-sessions.js"
import type { TranscriptEntry } from "../app/transcript.js"
import type { ModelPickerItem, ModelPickerStatus } from "../inference/picker-catalog.js"
import type { ModelProvider } from "../inference/types.js"
import type { ThemeName } from "../local/settings.js"

export type { ThemeName } from "../local/settings.js"

import type { LocalStats } from "../local/stats.js"
import type { ToolActivityKind } from "../tools/activity.js"

export const DESKTOP_CHANNELS = {
  getSnapshot: "desktop:get-snapshot",
  sendPrompt: "desktop:send-prompt",
  stop: "desktop:stop",
  respondToPermission: "desktop:respond-to-permission",
  selectSession: "desktop:select-session",
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
  setTheme: "desktop:set-theme",
  setThinkingVisible: "desktop:set-thinking-visible",
  setFastServing: "desktop:set-fast-serving",
  openFireworksKeyPage: "desktop:open-fireworks-key-page",
  setFireworksApiKey: "desktop:set-fireworks-api-key",
  connectPairEndpoints: "desktop:connect-pair-endpoints",
  listDownloadedModels: "desktop:list-downloaded-models",
  deleteLocalModel: "desktop:delete-local-model",
  setDebugMode: "desktop:set-debug-mode",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  event: "desktop:event",
} as const

export type TurnPhase = "idle" | "thinking" | "working"

export type PendingPermission = {
  id: number
  label: string
  kind: ToolActivityKind
  resources: string[]
}

/** Lifecycle of the selected model's inference client. Prompts are only accepted in the `ready` state. */
export type ModelState = "unconfigured" | "starting" | "ready" | "failed"

/** Update lifecycle shared by automatic checks, Settings, and the restart affordance. */
export type DesktopUpdateState =
  | { status: "idle" | "checking" | "current" | "unavailable" }
  | { status: "downloading" | "ready"; version: string }
  | { status: "error"; message: string }

/** One delegated run as the panel lists it: identity, lifecycle, and its tool-call count. */
export type SubagentSummary = {
  toolCallId: string
  title: string
  status: "running" | "complete" | "failed" | "interrupted"
  durationMs?: number
  tools: number
}

/** The mutable application state outside the transcript. Sent whole on every change; it is small. */
export type DesktopStatus = {
  busy: boolean
  phase: TurnPhase
  model: { id: string; provider: ModelProvider; displayName?: string } | null
  modelState: ModelState
  modelError: string | undefined
  session: { id: string; title: string } | null
  /** The active session's working folder is unknown or gone; locate it before agent work continues. */
  needsWorkspace: boolean
  /** Global history: sessions from every registered workspace, recency-ordered. */
  sessions: GlobalSessionPickerItem[]
  /** The workspace this window is working in. */
  workspace: { label: string; path: string }
  contextTokens: number | undefined
  contextLimit: number
  diffs: { added: number; removed: number }
  permission: PendingPermission | null
  /** Local usage statistics; undefined until the first scan completes. */
  stats: LocalStats | undefined
  /**
   * Progress or terminal error of a model load in flight, keyed by picker item id. Progress entries clear when the
   * load completes; error entries stay until the next selection attempt so an open picker can show the failure.
   */
  modelLoad: { modelId: string; status: ModelPickerStatus } | null
  /** The session's delegated runs, oldest first. */
  subagents: SubagentSummary[]
  /** The delegated-runs rail preference; persisted as subagentPanelVisible in local settings. */
  agentsPanelVisible: boolean
  /** The active color theme; persisted in local settings. */
  theme: ThemeName
  /** Reasoning renders as trace cards when on; plain muted text when off. Persisted in local settings. */
  thinkingVisible: boolean
  /** Fast serving for the selected hosted model: whether it has a fast path, and whether that path is active. */
  fastServing: { available: boolean; enabled: boolean }
  /** A Fireworks API key is configured. The key itself is never sent to the renderer. */
  hostedConfigured: boolean
  /** At least one NVIDIA PAIR endpoint is configured. */
  pairConfigured: boolean
  /** The saved PAIR endpoint addresses (loopback URLs), for prefilling the connect form. */
  pairEndpoints: { ollama?: string; lmStudio?: string }
  /** Session-only debug mode, mirroring the TUI's /debug toggle; applies from the next turn. */
  debug: boolean
  update: DesktopUpdateState
}

/** A downloaded local model, listed in settings for deletion; detail mirrors the TUI's delete menu rows. */
export type DownloadedLocalModel = {
  id: string
  displayName: string
  /** "Active · Q4_K_M · 4.8 GB" — the TUI delete-menu description. */
  detail: string
  active: boolean
}

export type DesktopSnapshot = DesktopStatus & {
  platform: NodeJS.Platform
  version: string
  entries: TranscriptEntry[]
  revision: number
}

export type TranscriptPatchOp =
  | { op: "reset"; entries: TranscriptEntry[] }
  | { op: "upsert"; entry: TranscriptEntry }
  | { op: "remove"; id: number }

/**
 * Ordered updates from the main process. Every event carries the shared revision counter so a renderer that
 * reloaded can discard anything it already received in its snapshot.
 */
export type DesktopEvent =
  | { type: "transcript"; revision: number; ops: TranscriptPatchOp[] }
  | { type: "status"; revision: number; status: DesktopStatus }

export type SendPromptResult =
  | { accepted: true; delivery: "started" | "steered" | "queued" }
  | { accepted: false; reason: string }

export type SessionOpResult = { ok: true } | { ok: false; reason: string }

export type ModelSelectResult = { ok: true } | { ok: false; reason: string }

/** The API surface exposed to the renderer through the preload bridge. */
export type DesktopApi = {
  getSnapshot(): Promise<DesktopSnapshot>
  sendPrompt(text: string): Promise<SendPromptResult>
  stop(): Promise<void>
  respondToPermission(id: number, allow: boolean): Promise<void>
  selectSession(id: string, dirName?: string): Promise<SessionOpResult>
  /** Title-first session search for the command palette; content matches carry a snippet. */
  searchSessions(query: string): Promise<GlobalSessionPickerItem[]>
  startNewSession(): Promise<SessionOpResult>
  deleteSession(id: string, dirName?: string): Promise<SessionOpResult>
  /** Recomputes the global session list; the palette calls this when it opens so external (TUI) sessions appear. */
  refreshSessions(): Promise<void>
  /** Opens a session from global history, switching workspace first when it lives elsewhere. dirName pins the
   * session's storage identity so a relocated or duplicate id can't resolve to a different conversation. */
  openSessionAt(workspacePath: string, sessionId: string, dirName?: string): Promise<SessionOpResult>
  /** Switches the window to another workspace (validated, refused during active work). */
  openWorkspace(path: string): Promise<SessionOpResult>
  /** Locates the working folder for a read-only pending session and completes its recovery. */
  locateWorkspace(path: string): Promise<SessionOpResult>
  /** Native folder picker; undefined when cancelled. */
  pickWorkspaceFolder(): Promise<string | undefined>
  /** "Locate workspace": registers the folder for a session dir that predates workspace registration. */
  registerWorkspace(dirName: string, path: string): Promise<SessionOpResult>
  /** The picker catalog for this machine: local fits, saved PAIR endpoints, and the verified hosted list. */
  listModels(): Promise<ModelPickerItem[]>
  /**
   * Selects a picker item, downloading and loading a managed local model when needed. `id` is the item id, or the
   * selectionKey for PAIR entries whose plain ids collide across engines. Resolves when the switch finishes.
   */
  selectModel(id: string): Promise<ModelSelectResult>
  /** Cancels an in-flight model selection; a completed or absent selection is a no-op. */
  cancelModelSelection(): Promise<void>
  /** The full transcript of one delegated run, for the trace view. Empty when the run is gone. */
  getSubagentTrace(toolCallId: string): Promise<TranscriptEntry[]>
  /** Shows or hides the delegated-runs rail; persisted across launches. */
  setAgentsPanelVisible(visible: boolean): Promise<void>
  /** Applies and persists a color theme. Unknown theme names are ignored. */
  setTheme(theme: ThemeName): Promise<void>
  /** Shows thinking as trace cards or as plain muted text; persisted in local settings. */
  setThinkingVisible(visible: boolean): Promise<void>
  /** Shows or hides reasoning traces in the transcript and subagent traces; persisted across launches. */
  /** Toggles Fast serving for the selected hosted model, re-selecting it on the fast or standard path. */
  setFastServing(fast: boolean): Promise<ModelSelectResult>
  /** Opens https://app.fireworks.ai/api-keys in the system browser. */
  openFireworksKeyPage(): Promise<void>
  /** Validates a Fireworks API key against the hosted catalog, then persists and activates it. */
  setFireworksApiKey(apiKey: string): Promise<ModelSelectResult>
  /** Validates, probes, and persists NVIDIA PAIR endpoints, keeping only the ones that respond. */
  connectPairEndpoints(endpoints: { ollama?: string; lmStudio?: string }): Promise<ModelSelectResult>
  /** The downloaded local models, for the settings delete list. */
  listDownloadedModels(): Promise<DownloadedLocalModel[]>
  /** Deletes a downloaded local model, clearing the selection first when it is the active one. */
  deleteLocalModel(id: string): Promise<ModelSelectResult>
  /** Session-only debug mode; applies from the next turn. */
  setDebugMode(enabled: boolean): Promise<void>
  /** Checks the release feed; progress and results arrive through the status stream. */
  checkForUpdates(): Promise<void>
  /** Restarts into the downloaded update. No-op when no update is ready. */
  installUpdate(): Promise<void>
  subscribe(listener: (event: DesktopEvent) => void): () => void
}
