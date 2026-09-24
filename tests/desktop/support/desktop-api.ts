import { vi } from "vitest"
import type { DesktopApi, DesktopSnapshot, DesktopStatus } from "../../../src/desktop/contracts.js"

/**
 * The quiet, unconfigured status renderer tests start from; each suite layers its own model,
 * session, and workspace on top.
 */
export const STATUS: DesktopStatus = {
  busy: false,
  phase: "idle",
  speed: null,
  model: null,
  modelState: "unconfigured",
  modelError: undefined,
  session: null,
  artifacts: [],
  needsWorkspace: false,
  sessions: [],
  recentArtifacts: [],
  workspace: { label: "ws", path: "/ws" },
  contextTokens: undefined,
  contextLimit: 32_768,
  diffs: { added: 0, removed: 0 },
  permission: null,
  permissionQueue: 0,
  runtimes: [
    {
      runtime: 1,
      session: null,
      focused: true,
      busy: false,
      unseen: false,
      diffs: { added: 0, removed: 0 },
      contextTokens: 0,
    },
  ],
  working: 0,
  panes: [1],
  paneAxis: "row",
  stats: undefined,
  modelLoad: null,
  subagents: [],
  agentsPanelVisible: true,
  workspacePanelWidth: undefined,
  theme: "default",
  language: "system",
  thinkingVisible: false,
  notifyOnCompletion: true,
  permissionMode: "auto",
  localThinking: null,
  fastServing: { available: false, enabled: false },
  hostedConfigured: false,
  pairConfigured: false,
  pairEndpoints: {},
  debug: false,
  update: { status: "idle" },
}

export function statusFixture(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return { ...STATUS, ...overrides }
}

export function snapshotFixture(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    ...STATUS,
    platform: "darwin",
    version: "0.0.0-test",
    entries: [],
    transcripts: {},
    revision: 1,
    ...overrides,
  }
}

/** A DesktopApi whose every call succeeds and is observable; `snapshot` is what getSnapshot serves. */
export function fakeApi(
  snapshot: DesktopSnapshot,
  overrides: Partial<DesktopApi> = {},
): DesktopApi {
  return {
    getSnapshot: vi.fn(async () => snapshot),
    getArtifact: vi.fn(async () => ({ ok: false as const, stale: true, reason: "stale" })),
    openArtifact: vi.fn(async () => ({ ok: true as const })),
    closeArtifact: vi.fn(async () => {}),
    saveArtifact: vi.fn(async () => ({ ok: true as const })),
    getWindowState: vi.fn(async () => ({ fullscreen: false })),
    sendPrompt: vi.fn(async () => ({ accepted: true as const, delivery: "started" as const })),
    stop: vi.fn(async () => {}),
    openPane: vi.fn(async () => {}),
    closePane: vi.fn(async () => {}),
    soloPane: vi.fn(async () => {}),
    replacePane: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    selectSession: vi.fn(async () => ({ ok: true as const })),
    focusSession: vi.fn(async () => {}),
    searchSessions: vi.fn(async () => []),
    startNewSession: vi.fn(async () => ({ ok: true as const })),
    deleteSession: vi.fn(async () => ({ ok: true as const })),
    openSessionAt: vi.fn(async () => ({ ok: true as const })),
    openWorkspace: vi.fn(async () => ({ ok: true as const })),
    locateWorkspace: vi.fn(async () => ({ ok: true as const })),
    pickWorkspaceFolder: vi.fn(async () => undefined),
    registerWorkspace: vi.fn(async () => ({ ok: true as const })),
    refreshSessions: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    selectModel: vi.fn(async () => ({ ok: true as const })),
    cancelModelSelection: vi.fn(async () => {}),
    getSubagentTrace: vi.fn(async () => []),
    setAgentsPanelVisible: vi.fn(async () => {}),
    setWorkspacePanelWidth: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    setLanguage: vi.fn(async () => {}),
    setThinkingVisible: vi.fn(async () => {}),
    setNotifyOnCompletion: vi.fn(async () => {}),
    setLocalThinking: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setFastServing: vi.fn(async () => ({ ok: true as const })),
    openFireworksKeyPage: vi.fn(async () => {}),
    setFireworksApiKey: vi.fn(async () => ({ ok: true as const })),
    connectLocalServers: vi.fn(async () => ({ ok: true as const })),
    deleteLocalModel: vi.fn(async () => ({ ok: true as const })),
    setDebugMode: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    checkForUpdates: vi.fn(async () => {}),
    subscribeWindowState: vi.fn(() => () => {}),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  }
}
