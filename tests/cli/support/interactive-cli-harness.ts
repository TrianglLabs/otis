import { beforeEach, vi } from "vitest"
import type { SetupCredential } from "../../../src/cli/ui/types.js"
import type { ChatMessage, FireworksModel } from "../../../src/inference/types.js"
import type { ThemeName } from "../../../src/local/settings.js"
import type { SessionToolActivity } from "../../../src/storage/index.js"

const mocks = vi.hoisted(() => {
  const rendererHandlers = new Map<string, Array<() => void>>()
  const renderer = {
    destroy: vi.fn(),
    off: vi.fn((event: string, handler: () => void) => {
      rendererHandlers.set(
        event,
        (rendererHandlers.get(event) ?? []).filter((candidate) => candidate !== handler),
      )
      return renderer
    }),
    on: vi.fn((event: string, handler: () => void) => {
      rendererHandlers.set(event, [...(rendererHandlers.get(event) ?? []), handler])
      return renderer
    }),
    once: vi.fn((event: string, handler: () => void) => {
      const wrapped = () => {
        renderer.off(event, wrapped)
        handler()
      }
      rendererHandlers.set(event, [...(rendererHandlers.get(event) ?? []), wrapped])
      return renderer
    }),
    requestRender: vi.fn(),
    resetSplitFooterForReplay: vi.fn(),
  }
  const ui = {
    clearInput: vi.fn(),
    focusInput: vi.fn(),
    hideModelPicker: vi.fn(),
    hidePermissionPrompt: vi.fn(),
    hideSessionPicker: vi.fn(),
    hideUpdateHint: vi.fn(),
    renderTranscript: vi.fn(),
    setAgentPhase: vi.fn(),
    setBusy: vi.fn(),
    setConfigured: vi.fn(),
    setContextLabel: vi.fn(),
    setDiffStats: vi.fn(),
    setModeLabel: vi.fn(),
    setModelLabel: vi.fn(),
    setSessionLabel: vi.fn(),
    setStats: vi.fn(),
    setTheme: vi.fn(),
    showChatLayout: vi.fn(),
    showHomeLayout: vi.fn(),
    showModelPicker: vi.fn(),
    showPermissionPrompt: vi.fn(() => Promise.resolve(true)),
    showSessionPicker: vi.fn(),
    showSetupError: vi.fn(),
    showSetupButton: vi.fn(),
    showSetupInput: vi.fn(),
    showSetupStatus: vi.fn(),
    showStats: vi.fn(),
    showUpdateHint: vi.fn(),
    startBusyIndicator: vi.fn(),
    stopBusyIndicator: vi.fn(),
  }
  const streamChat = vi.fn()
  const generateCompletion = vi.fn(async () => "")

  return {
    calculateLocalStats: vi.fn(async () => ({
      streak: 0,
      totalTokens: 0,
      sessionCount: 0,
      avgTokensPerSession: 0,
      avgSessionSeconds: 0,
    })),
    createChatUI: vi.fn((_renderer, options) => {
      mocks.uiOptions = options
      return ui
    }),
    createCliRenderer: vi.fn(async () => renderer),
    createSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    describeToolCall: vi.fn(() => ({ kind: "shell", label: "Running tool" })),
    FireworksClient: vi.fn(function FireworksClient(config: { model: string }) {
      return { model: config.model, streamChat, complete: generateCompletion }
    }),
    ParallelClient: vi.fn(function ParallelClient() {
      return { search: vi.fn(), read: vi.fn() }
    }),
    generateCompletion,
    getTreeSitterClient: vi.fn(() => ({ initialize: vi.fn(async () => undefined) })),
    listSessions: vi.fn<(_options?: unknown) => Promise<unknown[]>>(async () => []),
    listToolCapableModels: vi.fn<() => Promise<FireworksModel[]>>(async () => [testModel()]),
    loadLocalSettings: vi.fn(async () => localSettings()),
    loadProjectContext: vi.fn<(_cwd: string) => Array<{ path: string; content: string }>>(() => []),
    openSession: vi.fn(),
    openProviderKeyPage: vi.fn(async () => true),
    saveFireworksSetup: vi.fn(async () => undefined),
    saveParallelApiKey: vi.fn(async () => undefined),
    saveSelectedModel: vi.fn(async () => undefined),
    saveSelectedTheme: vi.fn(async () => undefined),
    checkForUpdate: vi.fn<
      (options?: { signal?: AbortSignal }) => Promise<{ available: boolean; version: string } | null>
    >(async () => null),
    renderer,
    rendererHandlers,
    runAgent: vi.fn(),
    runUpdateCommand: vi.fn(),
    streamChat,
    ui,
    uiOptions: undefined as
      | undefined
      | {
          configured?: boolean
          modelLabel?: string
          statsVisible?: boolean
          onCloseModelPicker?(): void
          onDeleteSession?(sessionId: string): void
          onInterrupt?(): void
          onPreviewTheme?(theme: ThemeName): void
          onSelectModel?(model: FireworksModel): void
          onSelectSession?(sessionId: string): void
          onSetup?(): void
          onSetupSubmit?(credential: SetupCredential, apiKey: string): void
          onSubmit(value: string): void
          onToggleMode?(): void
        },
  }
})

vi.mock("@opentui/core", () => ({
  createCliRenderer: mocks.createCliRenderer,
  getTreeSitterClient: mocks.getTreeSitterClient,
  RGBA: { fromHex: (value: string) => value },
  SyntaxStyle: { fromStyles: (styles: unknown) => styles },
}))

vi.mock("../../../src/core/agent.js", () => ({ runAgent: mocks.runAgent }))
vi.mock("../../../src/core/context.js", () => ({ loadProjectContext: mocks.loadProjectContext }))
vi.mock("../../../src/inference/client.js", () => ({
  FireworksClient: mocks.FireworksClient,
  listToolCapableModels: mocks.listToolCapableModels,
}))
vi.mock("../../../src/web/client.js", () => ({ ParallelClient: mocks.ParallelClient }))
vi.mock("../../../src/local/settings.js", () => ({
  isThemeName: (value: unknown) => ["default", "nord", "bright", "matrix"].includes(String(value)),
  loadLocalSettings: mocks.loadLocalSettings,
  saveFireworksSetup: mocks.saveFireworksSetup,
  saveParallelApiKey: mocks.saveParallelApiKey,
  saveSelectedModel: mocks.saveSelectedModel,
  saveSelectedTheme: mocks.saveSelectedTheme,
}))
vi.mock("../../../src/local/stats.js", () => ({ calculateLocalStats: mocks.calculateLocalStats }))
vi.mock("../../../src/storage/index.js", () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
  listSessions: mocks.listSessions,
  openSession: mocks.openSession,
}))
vi.mock("../../../src/tools/index.js", () => ({
  describeToolCall: mocks.describeToolCall,
  TOOL_DEFINITIONS: [],
}))
vi.mock("../../../src/cli/chat-ui.js", () => ({ createChatUI: mocks.createChatUI }))
vi.mock("../../../src/cli/provider-links.js", () => ({ openProviderKeyPage: mocks.openProviderKeyPage }))
vi.mock("../../../src/cli/update.js", () => ({
  checkForUpdate: mocks.checkForUpdate,
  runUpdateCommand: mocks.runUpdateCommand,
}))

export function getMocks() {
  return mocks
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.uiOptions = undefined
  mocks.rendererHandlers.clear()
  mocks.createSession.mockResolvedValue(testSession())
  mocks.listSessions.mockResolvedValue([])
  mocks.listToolCapableModels.mockResolvedValue([testModel()])
  mocks.loadLocalSettings.mockResolvedValue(localSettings())
  mocks.checkForUpdate.mockResolvedValue(null)
})

export async function loadCli() {
  await import("../../../src/cli/index.js")
  if (!mocks.uiOptions) throw new Error("Chat UI was not created")
}

export async function submit(value: string) {
  mocks.uiOptions?.onSubmit(value)
  await settle()
}

export async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

export function testSession(overrides: Partial<ReturnType<typeof baseSession>> = {}) {
  return { ...baseSession(), ...overrides }
}

function baseSession() {
  return {
    admitPrompt: vi.fn(async (content: string) => ({
      promptId: `prompt_${content}`,
      message: { role: "user" as const, content },
    })),
    completeTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    hasTitle: vi.fn(() => false),
    id: "session_test",
    recordUsage: vi.fn(async () => undefined),
    renameTitle: vi.fn(async () => undefined),
    replay: vi.fn<() => { messages: ChatMessage[]; toolActivities: SessionToolActivity[] }>(() => ({
      messages: [],
      toolActivities: [],
    })),
    replayMessages: vi.fn(() => []),
    title: vi.fn(() => "Current session"),
  }
}

export function localSettings(overrides: Record<string, unknown> = {}) {
  return {
    fireworksApiKey: "fw_test_key",
    parallelApiKey: "parallel_test_key",
    model: "accounts/fireworks/models/test-model",
    modelDisplayName: "Test Model",
    modelContextLength: 131_072,
    ...overrides,
  }
}

export function testModel(overrides: Partial<FireworksModel> = {}): FireworksModel {
  return {
    id: "accounts/fireworks/models/test-model",
    displayName: "Test Model",
    contextLength: 131_072,
    ...overrides,
  }
}

export function clone(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}
