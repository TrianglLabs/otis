import { afterEach, beforeEach, vi } from "vitest"
import type { LocalModelSpec } from "../../../src/inference/local-catalog.js"
import type { ChatMessage, FireworksModel, UserChatMessage } from "../../../src/inference/types.js"
import type { ThemeName } from "../../../src/local/settings.js"
import type { SkillCatalog } from "../../../src/skills/index.js"
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
    setImageAttachmentCount: vi.fn(),
    setModelLabel: vi.fn(),
    setModelPickerStatus: vi.fn(),
    setSessionLabel: vi.fn(),
    setStats: vi.fn(),
    setTheme: vi.fn(),
    setThinkingVisible: vi.fn(),
    setCommands: vi.fn(),
    showChatLayout: vi.fn(),
    showCommandSubmenu: vi.fn(),
    showHomeLayout: vi.fn(),
    showModelPicker: vi.fn(),
    showPermissionPrompt: vi.fn(() => Promise.resolve(true)),
    showSessionPicker: vi.fn(),
    showSetupError: vi.fn(),
    showSetupButton: vi.fn(),
    showSetupInput: vi.fn(),
    showSetupStatus: vi.fn(),
    showStats: vi.fn(),
    showTransientHint: vi.fn(),
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
    clearSelectedModel: vi.fn(async () => undefined),
    createChatUI: vi.fn((_renderer, options) => {
      mocks.uiOptions = options
      return ui
    }),
    createCliRenderer: vi.fn(async () => renderer),
    createSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    deleteLocalGguf: vi.fn(async () => undefined),
    describeToolCall: vi.fn(() => ({ kind: "shell", label: "Running tool" })),
    FireworksClient: vi.fn(function FireworksClient(config: { model: string }) {
      return { model: config.model, streamChat, complete: generateCompletion }
    }),
    ParallelClient: vi.fn(function ParallelClient() {
      return { search: vi.fn(), read: vi.fn() }
    }),
    generateCompletion,
    getTreeSitterClient: vi.fn(() => ({ initialize: vi.fn(async () => undefined) })),
    listDownloadedLocalModels: vi.fn<(_dataDirectory?: string) => Promise<LocalModelSpec[]>>(async () => []),
    listSessions: vi.fn<(_options?: unknown) => Promise<unknown[]>>(async () => []),
    listToolCapableModels: vi.fn<(_apiKey?: string, _options?: { signal?: AbortSignal }) => Promise<FireworksModel[]>>(
      async () => [testModel()],
    ),
    loadLocalSettings: vi.fn(async () => localSettings()),
    loadProjectContext: vi.fn<(_cwd: string) => Array<{ path: string; content: string }>>(() => []),
    loadSkillCatalog: vi.fn<() => Promise<SkillCatalog>>(async () => ({ skills: [], byName: new Map() })),
    openSession: vi.fn(),
    openFireworksKeyPage: vi.fn(async () => true),
    saveFireworksSetup: vi.fn(async () => undefined),
    saveSelectedModel: vi.fn(async () => undefined),
    saveSelectedTheme: vi.fn(async () => undefined),
    saveThinkingVisible: vi.fn(async () => undefined),
    saveFastMode: vi.fn(async () => undefined),
    detectHardware: vi.fn(async () => ({
      platform: "darwin" as const,
      arch: "arm64",
      totalMemoryBytes: 128 * 1024 ** 3,
      gpuMemoryBytes: 128 * 1024 ** 3,
      backend: "metal" as const,
      unifiedMemory: true,
    })),
    ensureLocalServing: vi.fn(
      async (
        spec: { id: string },
        _fit?: unknown,
        _hardware?: unknown,
        options?: { signal?: AbortSignal; onProgress?: (progress: { phase: string; percent?: number }) => void },
      ) => {
        options?.onProgress?.({ phase: "download", percent: 47 })
        options?.onProgress?.({ phase: "loading" })
        return {
          model: spec.id,
          inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
          contextLength: 32_768,
        }
      },
    ),
    stopLocalRuntime: vi.fn(async () => undefined),
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
          onCloseModelPicker?(): void
          onDeleteSession?(sessionId: string): void
          onInterrupt?(): void
          onQuit?(): void | Promise<void>
          onImagePaste?(bytes: Uint8Array, mimeType?: string): void | Promise<void>
          onImagePathPaste?(value: string): boolean
          onRemoveLastImage?(): boolean
          onPreviewTheme?(theme: ThemeName): void
          onSelectModel?(model: import("../../../src/inference/picker-catalog.js").ModelPickerItem): void
          onSelectSession?(sessionId: string): void
          onSetup?(): void
          onSetupSubmit?(apiKey: string): void
          onSubmit(value: string): void | Promise<void>
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
vi.mock("../../../src/skills/index.js", () => ({
  emptySkillCatalog: () => ({ skills: [], byName: new Map() }),
  loadSkillCatalog: mocks.loadSkillCatalog,
}))
vi.mock("../../../src/inference/client.js", () => ({
  FireworksClient: mocks.FireworksClient,
  listToolCapableModels: mocks.listToolCapableModels,
}))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
  return {
    ...actual,
    deleteLocalGguf: mocks.deleteLocalGguf,
    listDownloadedLocalModels: mocks.listDownloadedLocalModels,
  }
})
vi.mock("../../../src/web/client.js", () => ({ ParallelClient: mocks.ParallelClient }))
vi.mock("../../../src/local/settings.js", () => ({
  THEME_NAMES: ["default", "nord", "bright", "matrix", "midnight", "graphite", "beige", "vice", "eagan"],
  isThemeName: (value: unknown) =>
    ["default", "nord", "bright", "matrix", "midnight", "graphite", "beige", "vice", "eagan"].includes(String(value)),
  clearSelectedModel: mocks.clearSelectedModel,
  loadLocalSettings: mocks.loadLocalSettings,
  saveFireworksSetup: mocks.saveFireworksSetup,
  saveSelectedModel: mocks.saveSelectedModel,
  saveSelectedTheme: mocks.saveSelectedTheme,
  saveThinkingVisible: mocks.saveThinkingVisible,
  saveFastMode: mocks.saveFastMode,
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
vi.mock("../../../src/inference/hardware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/inference/hardware.js")>()
  return { ...actual, detectHardware: mocks.detectHardware }
})
vi.mock("../../../src/inference/llama-runtime.js", () => ({
  LlamaCppRuntime: vi.fn(function LlamaCppRuntime() {
    return { ensureServing: mocks.ensureLocalServing, stop: mocks.stopLocalRuntime }
  }),
}))
vi.mock("../../../src/cli/chat-ui.js", () => ({ createChatUI: mocks.createChatUI }))
vi.mock("../../../src/cli/provider-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/provider-links.js")>()
  return { ...actual, openFireworksKeyPage: mocks.openFireworksKeyPage }
})
vi.mock("../../../src/cli/update.js", () => ({
  checkForUpdate: mocks.checkForUpdate,
  runUpdateCommand: mocks.runUpdateCommand,
}))

export function getMocks() {
  return mocks
}

afterEach(async () => {
  await mocks.uiOptions?.onQuit?.()
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.uiOptions = undefined
  mocks.rendererHandlers.clear()
  mocks.createSession.mockResolvedValue(testSession())
  mocks.listDownloadedLocalModels.mockResolvedValue([])
  mocks.listSessions.mockResolvedValue([])
  mocks.listToolCapableModels.mockResolvedValue([testModel()])
  mocks.loadLocalSettings.mockResolvedValue(localSettings())
  mocks.loadSkillCatalog.mockResolvedValue({ skills: [], byName: new Map() })
  mocks.checkForUpdate.mockResolvedValue(null)
  mocks.detectHardware.mockResolvedValue({
    platform: "darwin",
    arch: "arm64",
    totalMemoryBytes: 128 * 1024 ** 3,
    gpuMemoryBytes: 128 * 1024 ** 3,
    backend: "metal",
    unifiedMemory: true,
  })
  mocks.ensureLocalServing.mockImplementation(
    async (
      spec: { id: string },
      _fit?: unknown,
      _hardware?: unknown,
      options?: { signal?: AbortSignal; onProgress?: (progress: { phase: string; percent?: number }) => void },
    ) => {
      options?.onProgress?.({ phase: "download", percent: 47 })
      options?.onProgress?.({ phase: "loading" })
      return {
        model: spec.id,
        inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
        contextLength: 32_768,
      }
    },
  )
  mocks.clearSelectedModel.mockResolvedValue(undefined)
  mocks.deleteLocalGguf.mockResolvedValue(undefined)
  mocks.stopLocalRuntime.mockImplementation(async () => undefined)
})

export async function loadCli() {
  await import("../../../src/cli/index.js")
  if (!mocks.uiOptions) throw new Error("Chat UI was not created")
}

export async function submit(value: string) {
  await mocks.uiOptions?.onSubmit(value)
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
    admitPrompt: vi.fn(async (input: string | UserChatMessage) => {
      const message = typeof input === "string" ? { role: "user" as const, content: input } : input
      const text = typeof message.content === "string" ? message.content : "image"
      return { promptId: `prompt_${text}`, message }
    }),
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
    model: "accounts/fireworks/models/test-model",
    modelDisplayName: "Test Model",
    modelContextLength: 131_072,
    modelSupportsImageInput: false,
    ...overrides,
  }
}

export function testModel(overrides: Partial<FireworksModel> = {}): FireworksModel {
  return {
    provider: "fireworks",
    id: "accounts/fireworks/models/test-model",
    displayName: "Test Model",
    contextLength: 131_072,
    supportsImageInput: false,
    ...overrides,
  }
}

export function clone(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}
