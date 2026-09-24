import { appendFile, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import type { TurnResult, TurnRunnerOptions } from "../../../src/app/turn-runner.js"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import { findLocalModel } from "../../../src/inference/local-catalog.js"
import type { discoverPairModels, PairEndpoints } from "../../../src/inference/pair.js"
import type {
  FireworksPickerChoice,
  LocalPickerChoice,
  listModelPickerItems,
  ModelPickerItem,
} from "../../../src/inference/picker-catalog.js"
import type {
  ChatMessage,
  InferenceClient,
  PairCatalogModel,
} from "../../../src/inference/types.js"
import { loadLocalSettings, saveSelectedModel } from "../../../src/local/settings.js"
import { sessionRootDirectory } from "../../../src/storage/session-files.js"
import { acquireSessionLock } from "../../../src/storage/session-lock.js"
import {
  readWorkspacePath,
  registerWorkspacePath,
} from "../../../src/storage/workspace-registry.js"
import { useOtisHome } from "../../app/support/otis-home.js"

const mocks = vi.hoisted(() => ({
  executeTurn: vi.fn(),
  listDownloaded: vi.fn<() => Promise<unknown[]>>(async () => []),
  deleteGguf: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock("../../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
  return {
    ...original,
    isLocalGgufDownloaded: async () => false,
    listDownloadedLocalModels: mocks.listDownloaded,
    deleteLocalGguf: mocks.deleteGguf,
  }
})

const isolate = useOtisHome()

const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }

function turnEvents(text: string) {
  return async (options: TurnRunnerOptions): Promise<TurnResult> => {
    await options.onEvent?.({ type: "delta", text })
    const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text }] }]
    await options.onEvent?.({ type: "complete", messages })
    return { status: "complete", messages, details: {} }
  }
}

async function setup(configureClient = true, extra: Record<string, unknown> = {}) {
  const home = await isolate("otis-desktop-")
  const cwd = join(home, "workspace")
  await mkdir(cwd, { recursive: true })
  const app = await Application.create({ cwd })
  if (configureClient) {
    app.models.client = fakeClient
    app.models.selectedId = "accounts/fireworks/models/fake"
    app.models.selectedProvider = "fireworks"
  }
  const sent: DesktopEvent[] = []
  const runtime = DesktopRuntime.forApplication(app, {
    cwd,
    version: "test",
    platform: "darwin",
    send: (event) => sent.push(event),
    ...extra,
  })
  return { app, runtime, sent, cwd }
}

/**
 * Stands in for model preparation: the selection commits by activating the fake client. `during`
 * runs inside preparation, where progress is reported and cancellation lands.
 */
function preparing(
  app: Application,
  during?: (options: {
    signal: AbortSignal
    onLocalProgress?: (p: never) => void
  }) => Promise<void>,
) {
  return vi.spyOn(app.models, "prepare").mockImplementation(async (model, options) => {
    await during?.(options as never)
    return {
      model,
      commit: () => app.models.activate(model, fakeClient),
      rollback: async () => {},
    }
  })
}

async function foreignSession(dirName: string, sessionId: string, text: string) {
  const dir = join(sessionRootDirectory(), dirName)
  await mkdir(dir, { recursive: true })
  const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
  await appendFile(
    join(dir, `${sessionId}.jsonl`),
    line({ seq: 1, sessionId, at: new Date().toISOString(), type: "session_started", version: 1 }) +
      line({
        seq: 2,
        sessionId,
        at: new Date().toISOString(),
        type: "prompt_admitted",
        promptId: "p1",
        message: { role: "user", content: text },
      }),
    { mode: 0o600 },
  )
}

/** Flushes the runtime's batched event pump (32ms interval). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

describe("DesktopRuntime model startup", () => {
  it("starts the saved local model so a client exists before prompts are accepted", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "local",
      id: "Qwen/Qwen3.8-27B",
      displayName: "Qwen3.8 27B",
      contextLength: 32_768,
      supportsImageInput: false,
    })

    const app = await Application.create({ cwd })
    expect(app.models.client).toBeUndefined()
    const prepare = vi.spyOn(app.models, "prepare").mockImplementation(async (model) => ({
      model,
      commit: () => app.models.activate(model, fakeClient),
      rollback: async () => {},
    }))

    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    await vi.waitFor(() => expect(app.models.client).toBe(fakeClient))
    expect(prepare).toHaveBeenCalledOnce()
    const snapshot = await runtime.snapshot()
    expect(snapshot.modelState).toBe("ready")
    expect(snapshot.model?.provider).toBe("local")
    await runtime.shutdown()
  })

  it("rejects prompts while the model is not running, without recording anything", async () => {
    const { runtime, app } = await setup(false)
    const result = await runtime.sendPrompt("hello")
    expect(result.accepted).toBe(false)
    expect(app.transcript.entries).toHaveLength(0)
    await runtime.shutdown()
  })

  it("selecting the failed saved model retries preparation instead of reporting false success", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "local",
      id: "Qwen/Qwen3.8-27B",
      displayName: "Qwen3.8 27B",
      contextLength: 32_768,
      supportsImageInput: false,
    })

    const app = await Application.create({ cwd })
    const activeRow: LocalPickerChoice = {
      kind: "model",
      provider: "local",
      id: "Qwen/Qwen3.8-27B",
      displayName: "Qwen3.8 27B",
      contextLength: 32_768,
      supportsImageInput: false,
      available: true,
      recommended: true,
      availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
      hasDownloadedPacking: true,
      cpuOffload: false,
      downloaded: true,
      active: true,
    }
    vi.spyOn(app.models, "prepare").mockRejectedValueOnce(new Error("no space left"))
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listPickerItems: async () => [activeRow],
      discoverPair: async () => ({ errors: [] }),
    })
    await vi.waitFor(async () => expect((await runtime.snapshot()).modelState).toBe("failed"))
    expect(app.models.client).toBeUndefined()

    const prepare = preparing(app)
    const result = await runtime.selectModel(activeRow.id)
    expect(result).toEqual({ ok: true })
    // The failed startup and the retry: the active row is not a dead shortcut.
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(app.models.client).toBe(fakeClient)
    expect((await runtime.snapshot()).modelState).toBe("ready")
    await runtime.shutdown()
  })
})

describe("DesktopRuntime subagents", () => {
  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  it("streams delegated runs through status and serves their transcripts", async () => {
    const { runtime } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const envelope = (event: Parameters<NonNullable<TurnRunnerOptions["onEvent"]>>[0]) =>
          ({ type: "subagent", toolCallId: "call_scout", title: "Scout the repo", event }) as const
        await options.onEvent?.(
          envelope({
            type: "tool",
            phase: "start",
            toolCallId: "read_1",
            name: "read",
            activityKind: "file_read",
            label: "Reading files: a.ts",
          }),
        )
        await options.onEvent?.(envelope({ type: "delta", text: "Found it." }))
        await gate
        await options.onEvent?.(
          envelope({
            type: "complete",
            messages: [{ role: "assistant", content: [{ type: "text", text: "Found it." }] }],
          }),
        )
        return {
          status: "complete",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
          details: {},
        }
      },
    )

    expect(await runtime.sendPrompt("delegate something")).toEqual({
      accepted: true,
      delivery: "started",
    })
    // While the run is mid-flight the panel sees it running with its tool count.
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).subagents).toEqual([
        { toolCallId: "call_scout", title: "Scout the repo", status: "running", tools: 1 },
      ])
    })

    release()
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).subagents[0]?.status).toBe("complete")
    })
    const finished = (await runtime.snapshot()).subagents[0]
    expect(finished).toMatchObject({
      toolCallId: "call_scout",
      title: "Scout the repo",
      status: "complete",
      tools: 1,
    })
    expect(finished?.durationMs).toBeGreaterThanOrEqual(0)

    const trace = await runtime.getSubagentTrace("call_scout")
    expect(
      trace.some((entry) => entry.kind === "tool" && entry.text.includes("Reading files")),
    ).toBe(true)
    expect(trace.some((entry) => entry.text === "Found it.")).toBe(true)
    expect(await runtime.getSubagentTrace("missing")).toEqual([])
    await runtime.shutdown()
  })

  it("applies and persists the theme, language, thinking, and permission preferences", async () => {
    const { app, runtime, sent } = await setup()
    expect((await runtime.snapshot()).theme).toBe("default")
    expect((await runtime.snapshot()).language).toBe("system")
    expect((await runtime.snapshot()).thinkingVisible).toBe(false)
    expect((await runtime.snapshot()).permissionMode).toBe("auto")

    await runtime.setTheme("nord")
    expect((await runtime.snapshot()).theme).toBe("nord")
    expect((await loadLocalSettings()).theme).toBe("nord")
    await flush()
    expect(sent.some((event) => event.type === "status" && event.status.theme === "nord")).toBe(
      true,
    )

    await runtime.setTheme("not-a-theme")
    expect((await runtime.snapshot()).theme).toBe("nord")

    await runtime.setLanguage("fr")
    expect((await runtime.snapshot()).language).toBe("fr")
    expect((await loadLocalSettings()).language).toBe("fr")
    await runtime.setLanguage("made-up")
    expect((await runtime.snapshot()).language).toBe("fr")

    await runtime.setThinkingVisible(true)
    expect((await runtime.snapshot()).thinkingVisible).toBe(true)
    expect((await loadLocalSettings()).thinkingVisible).toBe(true)

    await runtime.setPermissionMode("ask")
    expect((await runtime.snapshot()).permissionMode).toBe("ask")
    expect((await loadLocalSettings()).permissions?.defaultMode).toBe("ask")
    expect(
      await app.createPermissionPolicy().evaluate({ name: "bash", input: { command: "bun test" } }),
    ).toMatchObject({ effect: "ask" })
    await flush()
    expect(
      sent.some((event) => event.type === "status" && event.status.permissionMode === "ask"),
    ).toBe(true)
    expect(sent.some((event) => event.type === "status" && event.status.language === "fr")).toBe(
      true,
    )
    await runtime.shutdown()
  })

  it("persists local effort, rejects stale or unsupported selections, and invalidates counted context", async () => {
    const { app, runtime } = await setup()
    const model = "Qwen/Qwen3.8-27B"
    app.models.selectedId = model
    app.models.selectedProvider = "local"
    app.transcript.observeContext(fakeClient, 900)
    await runtime.setLocalThinking(model, "medium")
    expect((await runtime.snapshot()).localThinking?.selected).toBe("medium")
    expect((await loadLocalSettings()).localThinking?.[model]).toBe("medium")
    expect(app.transcript.contextTokens(fakeClient)).toBeUndefined()
    await expect(runtime.setLocalThinking(model, "high")).rejects.toThrow("does not support")
    await expect(runtime.setLocalThinking("openai/gpt-oss-20b", "low")).rejects.toThrow("changed")
    app.models.selectedProvider = "pair"
    expect((await runtime.snapshot()).localThinking).toBeNull()
    await expect(runtime.setLocalThinking(model, "low")).rejects.toThrow("changed")
    await runtime.shutdown()
  })

  it("rejects Fast serving for a local model", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    app.models.client = fakeClient
    app.models.selectedId = "openai/gpt-oss-20b"
    app.models.selectedProvider = "local"
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    const result = await runtime.setFastServing(true)
    expect(result).toEqual({ ok: false, reason: "Fast serving is not available for this model." })
    expect((await runtime.snapshot()).fastServing).toEqual({ available: false, enabled: false })
    await runtime.shutdown()
  })

  it("toggles Fast serving by re-selecting the model on its fast path", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    app.models.client = fakeClient
    app.models.selectedId = "accounts/fireworks/models/kimi"
    app.models.selectedProvider = "fireworks"
    vi.spyOn(app.models, "prepare").mockImplementation(async (model) => ({
      model,
      commit: () => app.models.activate(model, fakeClient),
      rollback: async () => {},
    }))
    const fireworksChoice: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      supportsImageInput: false,
      available: true,
      active: true,
      fastId: "accounts/fireworks/routers/kimi-fast",
    }
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listPickerItems: async () => [fireworksChoice],
    })

    const on = await runtime.setFastServing(true)
    expect(on).toEqual({ ok: true })
    expect(app.models.selectedId).toBe("accounts/fireworks/routers/kimi-fast")
    let snapshot = await runtime.snapshot()
    expect(snapshot.fastServing).toEqual({ available: true, enabled: true })
    let saved = await loadLocalSettings()
    expect(saved.model).toBe("accounts/fireworks/routers/kimi-fast")
    expect(saved.fastServingModels).toEqual(["accounts/fireworks/models/kimi"])

    const off = await runtime.setFastServing(false)
    expect(off).toEqual({ ok: true })
    expect(app.models.selectedId).toBe("accounts/fireworks/models/kimi")
    snapshot = await runtime.snapshot()
    expect(snapshot.fastServing).toEqual({ available: true, enabled: false })
    saved = await loadLocalSettings()
    expect(saved.model).toBe("accounts/fireworks/models/kimi")
    expect(saved.fastServingModels ?? []).toEqual([])
    await runtime.shutdown()
  })

  it("connects NVIDIA PAIR endpoints, keeping only the engines that respond", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    const pairModel = {
      provider: "pair" as const,
      engine: "ollama" as const,
      id: "qwen3:8b",
      selectionKey: "ollama/qwen3:8b",
      displayName: "qwen3 8b",
      baseURL: "http://127.0.0.1:11434",
      contextLength: 32_768,
      supportsImageInput: false,
    }
    const discoverPair = vi.fn(async () => ({ ollama: [pairModel], errors: [] }))
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      discoverPair: discoverPair as never,
    })

    expect(await runtime.connectLocalServers({})).toEqual({
      ok: false,
      reason: "Enter at least one local model server endpoint.",
    })
    expect(await runtime.connectLocalServers({ ollama: "https://example.com" })).toEqual({
      ok: false,
      reason: "Local model server endpoint must use HTTP on 127.0.0.1, localhost, or ::1.",
    })

    discoverPair.mockResolvedValueOnce({ errors: [{ engine: "ollama", message: "down" }] } as never)
    expect(await runtime.connectLocalServers({ ollama: "http://127.0.0.1:11434" })).toEqual({
      ok: false,
      reason:
        "No compatible model server was found. Start your local model server and check its address.",
    })

    const result = await runtime.connectLocalServers({ ollama: "http://127.0.0.1:11434/" })
    expect(result).toEqual({ ok: true })
    expect(app.pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    const snapshot = await runtime.snapshot()
    expect(snapshot.pairConfigured).toBe(true)
    expect(snapshot.pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    expect((await loadLocalSettings()).pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    await runtime.shutdown()
  })

  it("toggles session-only debug mode", async () => {
    const { runtime } = await setup()
    expect((await runtime.snapshot()).debug).toBe(false)
    await runtime.setDebugMode(true)
    expect((await runtime.snapshot()).debug).toBe(true)
    expect(await loadLocalSettings()).not.toHaveProperty("debug")
    await runtime.shutdown()
  })

  it("coordinates deletion with prompt admission and model selection", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "local",
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss 20B",
      contextLength: 32_768,
      supportsImageInput: false,
    })
    const app = await Application.create({ cwd })
    app.models.client = fakeClient
    app.models.selectedId = "openai/gpt-oss-20b"
    app.models.selectedProvider = "local"
    app.models.activeLocal = { spec: { id: "openai/gpt-oss-20b" }, contextLength: 32_768 } as never
    vi.spyOn(app.models.llama, "stop").mockResolvedValue(undefined)
    mocks.listDownloaded.mockResolvedValue([findLocalModel("openai/gpt-oss-20b")])
    let releaseDelete!: () => void
    mocks.deleteGguf.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDelete = resolve
        }),
    )
    const fireworksChoice: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      supportsImageInput: false,
      available: true,
      active: false,
    }
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listPickerItems: async () => [fireworksChoice],
    })

    const pending = runtime.deleteLocalModel("openai/gpt-oss-20b")
    await new Promise((resolve) => setTimeout(resolve, 10))

    // While deletion is pending, prompts are not admitted and other selections are refused.
    const prompt = await runtime.sendPrompt("hello")
    expect(prompt.accepted).toBe(false)
    if (!prompt.accepted)
      expect(prompt.reason).toBe("A model switch is in progress. Try again in a moment.")
    expect(await runtime.selectModel(fireworksChoice.id)).toEqual({
      ok: false,
      reason: "Finish the current work before switching models.",
    })

    releaseDelete()
    expect(await pending).toEqual({ ok: true })
    expect(app.models.selectedId).toBeUndefined()
    await runtime.shutdown()
  })

  it("marks a saved hosted model ready once its key is added", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      contextLength: 128_000,
      supportsImageInput: false,
    })
    const app = await Application.create({ cwd }) // no API key: the selection cannot start
    expect(app.models.client).toBeUndefined()
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listToolCapableModels: (async () => [{ id: "kimi" }]) as never,
    })
    expect((await runtime.snapshot()).modelState).not.toBe("ready")

    expect(await runtime.setFireworksApiKey("good-key")).toEqual({ ok: true })
    const snapshot = await runtime.snapshot()
    expect(snapshot.modelState).toBe("ready")
    expect(snapshot.model?.displayName).toBe("Kimi")
    expect(app.models.client?.model).toBe("accounts/fireworks/models/kimi")
    await runtime.shutdown()
  })

  it("rebuilds the active PAIR client when its endpoint changes, and invalidates it when dropped", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "pair",
      id: "qwen3:8b",
      displayName: "qwen3 8b",
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama",
      supportsImageInput: false,
    } as never)
    const app = await Application.create({ cwd })
    expect(app.models.selectedProvider).toBe("pair")
    const oldClient = app.models.client
    expect(oldClient).toBeDefined()
    const pairModel = {
      provider: "pair" as const,
      engine: "ollama" as const,
      id: "qwen3:8b",
      selectionKey: "ollama/qwen3:8b",
      displayName: "qwen3 8b",
      baseURL: "http://127.0.0.1:11435",
      contextLength: 32_768,
      supportsImageInput: false,
    }
    const lmModel = {
      ...pairModel,
      engine: "lmstudio" as const,
      selectionKey: "lmstudio/qwen3:8b",
      baseURL: "http://127.0.0.1:1234",
    }
    const discoverPair = vi.fn(async () => ({ ollama: [pairModel], errors: [] }))
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      discoverPair: discoverPair as never,
    })

    // Reconnect on a new port: the active client is rebuilt onto it.
    expect(await runtime.connectLocalServers({ ollama: "http://127.0.0.1:11435" })).toEqual({
      ok: true,
    })
    expect(app.models.client).not.toBe(oldClient)
    expect(app.models.autoCompactAtTokens).toBe(Math.floor(65_536 * 0.8))
    expect((await runtime.snapshot()).modelState).toBe("ready")

    // Reconnect with only the other engine responding: the orphaned selection is invalidated.
    discoverPair.mockResolvedValueOnce({ lmStudio: [lmModel], errors: [] } as never)
    expect(await runtime.connectLocalServers({ lmStudio: "http://127.0.0.1:1234" })).toEqual({
      ok: true,
    })
    expect(app.models.client).toBeUndefined()
    const snapshot = await runtime.snapshot()
    expect(snapshot.modelState).toBe("failed")
    expect(snapshot.modelError).toContain("no longer available")
    await runtime.shutdown()
  })

  it("reports fast serving availability from the saved selection at launch", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      contextLength: 128_000,
      supportsImageInput: false,
      fastId: "accounts/fireworks/routers/kimi-fast",
    } as never)
    const app = await Application.create({ cwd })
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    // No picker fetch has happened; the persisted fast id alone makes the toggle available.
    const snapshot = await runtime.snapshot()
    expect(snapshot.fastServing).toEqual({ available: true, enabled: false })
    expect(snapshot.model?.displayName).toBe("Kimi")
    await runtime.shutdown()
  })

  it("persists the agents rail visibility preference", async () => {
    const { runtime } = await setup()
    expect((await runtime.snapshot()).agentsPanelVisible).toBe(true)

    await runtime.setAgentsPanelVisible(false)
    expect((await runtime.snapshot()).agentsPanelVisible).toBe(false)
    expect((await loadLocalSettings()).subagentPanelVisible).toBe(false)

    await runtime.setAgentsPanelVisible(true)
    expect((await runtime.snapshot()).agentsPanelVisible).toBe(true)
    expect((await loadLocalSettings()).subagentPanelVisible).toBe(true)
    await runtime.shutdown()
  })

  it("persists the workspace panel width and clears it on reset", async () => {
    const { runtime } = await setup()
    expect((await runtime.snapshot()).workspacePanelWidth).toBeUndefined()
    await runtime.setWorkspacePanelWidth(431)
    expect((await runtime.snapshot()).workspacePanelWidth).toBe(431)
    expect((await loadLocalSettings()).workspacePanelWidth).toBe(431)
    await runtime.setWorkspacePanelWidth(undefined)
    expect((await runtime.snapshot()).workspacePanelWidth).toBeUndefined()
    expect((await loadLocalSettings()).workspacePanelWidth).toBeUndefined()
    await runtime.shutdown()
  })

  it("answers preview fetches with a result instead of an invoke error", async () => {
    const { runtime, app } = await setup()
    await writeFile(join(runtime.app.cwd, "notes.md"), "# Notes")
    app.artifacts.openWorkspace({ source: "workspace", kind: "markdown", path: "notes.md" })
    const revision = app.artifacts.metadata?.revision ?? 0
    const id = "workspace:notes.md"
    expect(await runtime.getArtifact(app.focused.id, id, revision)).toMatchObject({
      ok: true,
      payload: { content: "# Notes" },
    })
    expect(await runtime.getArtifact(app.focused.id, id, revision + 1)).toEqual({
      ok: false,
      stale: true,
      reason: "This preview changed.",
    })
    await rm(join(runtime.app.cwd, "notes.md"))
    expect(await runtime.getArtifact(app.focused.id, id, revision)).toEqual({
      ok: false,
      reason: expect.stringContaining("no longer at notes.md"),
    })
    await runtime.shutdown()
  })

  it("reports no runs for a turn without delegation", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("plain answer"))
    expect(await runtime.sendPrompt("hi")).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(async () => {
      expect(
        (await runtime.snapshot()).entries.some((entry) => entry.text === "plain answer"),
      ).toBe(true)
    })
    expect((await runtime.snapshot()).subagents).toEqual([])
    await runtime.shutdown()
  })
})

describe("DesktopRuntime conversation flow", () => {
  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  it("acknowledges a prompt only after admission and streams transcript updates", async () => {
    const { runtime, sent } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("Hello from the model"))

    const result = await runtime.sendPrompt("hi")
    expect(result).toEqual({ accepted: true, delivery: "started" })

    await vi.waitFor(async () => {
      const snapshot = await runtime.snapshot()
      expect(snapshot.entries.some((entry) => entry.text === "Hello from the model")).toBe(true)
    })
    await flush()
    const transcriptEvents = sent.filter((event) => event.type === "transcript")
    expect(transcriptEvents.length).toBeGreaterThan(0)
    const statusEvents = sent.filter((event) => event.type === "status")
    expect(statusEvents.at(-1)).toMatchObject({ status: { busy: false } })
    await runtime.shutdown()
  })

  it("validates and admits image-only prompts through the shared message pipeline", async () => {
    const { runtime, app } = await setup()
    app.models.supportsImageInput = true
    mocks.executeTurn.mockImplementation(turnEvents("I can see the image"))
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    expect(
      await runtime.sendPrompt("", [{ name: "screen.png", mimeType: "image/png", bytes }]),
    ).toEqual({
      accepted: true,
      delivery: "started",
    })
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalled())

    const input = mocks.executeTurn.mock.calls[0]?.[0].input
    expect(input).toMatchObject({
      role: "user",
      content: [
        {
          type: "image",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        },
      ],
    })
    expect(app.transcript.entries.find((entry) => entry.speaker === "You")?.text).toBe(
      "📎 screen.png",
    )
    await runtime.shutdown()
  })

  it("rejects image data before session admission when the model or file is incompatible", async () => {
    const { runtime, app } = await setup()
    const png = {
      name: "screen.png",
      mimeType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }

    const unsupportedModel = await runtime.sendPrompt("describe this", [png])
    expect(unsupportedModel).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("does not support"),
    })

    app.models.supportsImageInput = true
    const invalidFile = await runtime.sendPrompt("describe this", [
      { name: "fake.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ])
    expect(invalidFile).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("Unsupported image format"),
    })
    expect(app.transcript.entries).toHaveLength(0)
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    await runtime.shutdown()
  })

  it("admits documents on text-only models and preserves source metadata", async () => {
    const { runtime, app } = await setup()
    const bytes = new TextEncoder().encode("Desktop document text")

    const result = await runtime.sendPrompt("", [
      { name: "notes.md", mimeType: "text/markdown", bytes },
    ])

    expect(result).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalled())
    expect(mocks.executeTurn.mock.calls[0]?.[0].input).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "document",
          kind: "text",
          name: "notes.md",
          extractedText: "Desktop document text",
          sizeBytes: bytes.byteLength,
        }),
      ],
    })
    const userEntry = app.transcript.entries.find((entry) => entry.speaker === "You")
    expect(userEntry).toMatchObject({
      text: "📄 notes.md",
      messageText: "",
      artifacts: [
        expect.objectContaining({ source: "attachment", kind: "markdown", name: "notes.md" }),
      ],
    })
    const artifact = (await runtime.snapshot()).artifacts[0]?.artifact
    expect(artifact).toMatchObject({
      source: "attachment",
      kind: "markdown",
      title: "notes.md",
      editable: false,
    })
    expect(JSON.stringify(artifact)).not.toContain("Desktop document text")
    await expect(
      runtime.getArtifact(app.focused.id, artifact?.id ?? "", artifact?.revision ?? 0),
    ).resolves.toMatchObject({
      payload: { encoding: "utf8", content: "Desktop document text" },
    })
    app.transcript.loadCompacted("Attachment summary", [])
    const reference = userEntry?.artifacts?.[0]
    if (!reference) throw new Error("Document artifact reference is missing")
    expect(await runtime.openArtifact(reference)).toEqual({ ok: true })
    expect((await runtime.snapshot()).artifacts[0]?.artifact).toMatchObject({
      title: "notes.md",
      kind: "markdown",
    })
    await runtime.shutdown()
  })

  it("rejects an export prepared for a previous conversation", async () => {
    const { runtime, app } = await setup()
    await writeFile(join(runtime.app.cwd, "report.docx"), "source")
    app.artifacts.openWorkspace({ source: "workspace", kind: "docx", path: "report.docx" })
    const revision = app.artifacts.metadata?.revision ?? 0
    await expect(
      runtime.getArtifactFile(app.focused.id, "workspace:other.docx", 1),
    ).resolves.toBeUndefined()
    await expect(
      runtime.getArtifactFile(app.focused.id, "workspace:report.docx", revision),
    ).resolves.toEqual({ name: "report.docx", bytes: Buffer.from("source") })
    // The read is in flight when the conversation resets; the tab it was for is gone by then.
    const pending = runtime.getArtifactFile(app.focused.id, "workspace:report.docx", revision)
    expect(runtime.startNewSession()).toEqual({ ok: true })
    await expect(pending).resolves.toBeUndefined()
    await runtime.shutdown()
  })

  it.each([
    "new-session",
    "model",
    "shutdown",
    "renderer-gone",
  ] as const)("rejects a prepared attachment if %s changes before admission", async (change) => {
    const { runtime, app } = await setup()
    const send = runtime.sendPrompt("original conversation", [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("notes"),
      },
    ])
    // Even text decoding yields at the async attachment boundary; no sleeps or timing assumptions.
    if (change === "new-session") expect(runtime.startNewSession()).toEqual({ ok: true })
    if (change === "model") app.models.client = { ...fakeClient, model: "replacement" }
    if (change === "shutdown") await runtime.shutdown()
    if (change === "renderer-gone") runtime.handleRendererGone()

    expect(await send).toMatchObject({ accepted: false })
    expect(app.sessions.current).toBeUndefined()
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    if (change !== "shutdown") await runtime.shutdown()
  })
})

const completed = (): TurnResult => ({
  status: "complete",
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  details: {},
})

describe("DesktopRuntime cancellation and timing", () => {
  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  it("denies unanswered approvals when the renderer dies", async () => {
    const { runtime } = await setup()
    let allowed: boolean | undefined
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        allowed = await options.agent.onPermissionRequest?.({
          call: { name: "bash", input: { command: "echo test" } },
          decision: { effect: "ask", resources: ["echo test"] },
        })
        return { status: "interrupted", messages: [], details: {} }
      },
    )
    try {
      await runtime.sendPrompt("run a command")
      await vi.waitFor(async () => expect((await runtime.snapshot()).permission).not.toBeNull())
      runtime.handleRendererGone()
      await vi.waitFor(() => expect(allowed).toBe(false))
      expect((await runtime.snapshot()).permission).toBeNull()
    } finally {
      await runtime.shutdown()
    }
  })

  it("resumes the suspended queue only when the user sends again, preserving order", async () => {
    const { runtime, app } = await setup()
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls++
        await options.agent.steering?.drainOrClose()
        if (calls === 1) {
          const signal = options.agent.signal
          if (!signal) throw new Error("expected an abort signal")
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
          return { status: "interrupted", messages: [], details: {} }
        }
        return completed()
      },
    )
    try {
      await runtime.sendPrompt("first")
      await runtime.sendPrompt("second")
      runtime.handleRendererGone()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(calls).toBe(1)

      expect(await runtime.sendPrompt("third")).toMatchObject({
        accepted: true,
        delivery: "queued",
      })
      await vi.waitFor(() => expect(calls).toBe(3))
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      const userEntries = app.transcript.entries.filter((entry) => entry.speaker === "You")
      expect(userEntries.map((entry) => entry.text)).toEqual(["first", "second", "third"])
    } finally {
      await runtime.shutdown()
    }
  })

  it("keeps the stranded queue head when the resuming prompt fails admission", async () => {
    const { app, runtime } = await setup()
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls++
        await options.agent.steering?.drainOrClose()
        if (calls === 1) {
          const signal = options.agent.signal
          if (!signal) throw new Error("expected an abort signal")
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
          return { status: "interrupted", messages: [], details: {} }
        }
        return completed()
      },
    )
    try {
      await runtime.sendPrompt("first")
      await runtime.sendPrompt("second")
      runtime.handleRendererGone()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(calls).toBe(1)

      // The resuming prompt cannot be admitted (disk failure): it is rejected and "second" stays
      // queued.
      vi.spyOn(app.sessions, "ensure").mockRejectedValueOnce(new Error("disk full"))
      expect((await runtime.sendPrompt("third")).accepted).toBe(false)
      expect(calls).toBe(1)

      // A later send drains the backlog ahead of itself, in order.
      expect(await runtime.sendPrompt("fourth")).toMatchObject({
        accepted: true,
        delivery: "queued",
      })
      await vi.waitFor(() => expect(calls).toBe(3))
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      const userEntries = app.transcript.entries.filter((entry) => entry.speaker === "You")
      expect(userEntries.map((entry) => entry.text)).toEqual(["first", "second", "fourth"])
    } finally {
      await runtime.shutdown()
    }
  })
})

describe("DesktopRuntime sessions", () => {
  it("delivers Fresh start content and metadata together", async () => {
    const { runtime, sent } = await setup()
    try {
      mocks.executeTurn.mockImplementation(turnEvents("first session reply"))
      await runtime.sendPrompt("hello")
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      await flush()
      sent.length = 0

      expect(runtime.startNewSession()).toEqual({ ok: true })
      await vi.waitFor(() =>
        expect(sent.some((event) => event.type === "status" && event.ops)).toBe(true),
      )
      const reset = sent.find((event) => event.type === "status" && event.ops)
      expect(reset).toMatchObject({
        type: "status",
        status: { session: null, subagents: [], diffs: { added: 0, removed: 0 } },
        ops: [{ op: "reset", entries: [] }],
      })
      expect(
        sent.some(
          (event) => event.type === "transcript" && event.ops?.some((op) => op.op === "reset"),
        ),
      ).toBe(false)
    } finally {
      await runtime.shutdown()
    }
  })

  it("opens a fresh session beside a working one and marks the background completion", async () => {
    const { runtime, app } = await setup()
    try {
      let finish = () => {}
      mocks.executeTurn.mockImplementationOnce(async (options: TurnRunnerOptions) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return turnEvents("first reply")(options)
      })
      await runtime.sendPrompt("keep working")
      const first = app.focused
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(true))

      // A fresh start while working opens beside it; the working session stays open and counted.
      expect(runtime.startNewSession()).toEqual({ ok: true })
      let snapshot = await runtime.snapshot()
      expect(snapshot).toMatchObject({ busy: false, session: null, working: 1, entries: [] })
      expect(snapshot.runtimes.map((entry) => [entry.focused, entry.busy])).toEqual([
        [false, true],
        [true, false],
      ])
      expect(snapshot.sessions.find((session) => session.working)?.id).toBe(
        first.sessions.current?.id,
      )

      // The fresh session takes its own prompt; the first runtime's stream stays off the wire.
      mocks.executeTurn.mockImplementationOnce(turnEvents("second reply"))
      await runtime.sendPrompt("hello from the new one")
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      snapshot = await runtime.snapshot()
      expect(snapshot.entries.map((entry) => entry.text)).toEqual([
        "hello from the new one",
        "second reply",
      ])

      finish()
      await vi.waitFor(async () => expect((await runtime.snapshot()).working).toBe(0))
      snapshot = await runtime.snapshot()
      expect(snapshot.entries.some((entry) => entry.text === "first reply")).toBe(false)
      expect(snapshot.sessions.find((session) => session.unseen)?.id).toBe(
        first.sessions.current?.id,
      )

      // Selecting the finished session focuses its runtime and clears the mark.
      const back = await runtime.selectSession(first.sessions.current?.id ?? "")
      expect(back).toEqual({ ok: true })
      await vi.waitFor(async () => {
        const focused = await runtime.snapshot()
        expect(focused.entries.some((entry) => entry.text === "first reply")).toBe(true)
        expect(focused.sessions.some((session) => session.unseen)).toBe(false)
      })
    } finally {
      await runtime.shutdown()
    }
  })

  it("shows sessions side by side, each streaming its own pane, and moves focus without reloads", async () => {
    const { runtime, app, sent } = await setup()
    let finish = () => {}
    try {
      mocks.executeTurn.mockImplementation(turnEvents("first reply"))
      await runtime.sendPrompt("first")
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      const first = app.focused
      // The second session opens in a new runtime because the first is kept busy meanwhile.
      mocks.executeTurn.mockImplementationOnce(async (options: TurnRunnerOptions) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return turnEvents("first again")(options)
      })
      await runtime.sendPrompt("again")
      expect(runtime.startNewSession()).toEqual({ ok: true })
      const second = app.focused
      expect(second).not.toBe(first)
      await flush()

      // Dropping the first on the left: it arrives whole with the status that shows it.
      sent.length = 0
      runtime.openPane(first.id, "left")
      await flush()
      expect(sent.find((event) => event.type === "status")).toMatchObject({
        status: { panes: [first.id, second.id], paneAxis: "row" },
        panes: [{ runtime: first.id, ops: [{ op: "reset", entries: expect.any(Array) }] }],
      })
      const snapshot = await runtime.snapshot()
      expect(snapshot.transcripts[first.id]?.map((entry) => entry.text)).toEqual([
        "first",
        "first reply",
        "again",
      ])
      expect(snapshot.entries).toHaveLength(0)

      // The first keeps streaming as its own pane, on its own event or with a status.
      sent.length = 0
      finish()
      await vi.waitFor(async () => expect((await runtime.snapshot()).working).toBe(0))
      const paneOps = sent.flatMap((event) => event.panes ?? [])
      expect(
        paneOps.some(
          (pane) =>
            pane.runtime === first.id &&
            pane.ops.some((op) => op.op === "upsert" && op.entry.text === "first again"),
        ),
      ).toBe(true)

      // Activating the first moves focus without resending anything; the composer follows.
      sent.length = 0
      runtime.focusSession(first.id)
      await flush()
      const moved = sent.filter((event) => event.type === "status")
      expect(moved).toHaveLength(1)
      expect(moved[0]).not.toHaveProperty("ops")
      expect(moved[0]).not.toHaveProperty("panes")
      expect(sent.some((event) => event.type === "transcript")).toBe(false)
      expect((await runtime.snapshot()).entries.at(-1)?.text).toBe("first again")
      expect((await runtime.snapshot()).transcripts[second.id]).toEqual([])
      mocks.executeTurn.mockImplementationOnce(turnEvents("first once more"))
      expect(await runtime.sendPrompt("into the first")).toMatchObject({ accepted: true })
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).entries.at(-1)?.text).toBe("first once more"),
      )

      // A session already on screen moves to the side it is dropped on; two panes take its axis.
      runtime.openPane(second.id, "top")
      await flush()
      expect(await runtime.snapshot()).toMatchObject({
        panes: [second.id, first.id],
        paneAxis: "column",
      })

      // Closing the active card hands focus to its neighbor, again without a reload.
      sent.length = 0
      runtime.closePane(first.id)
      await flush()
      expect(sent.find((event) => event.type === "status")).toMatchObject({
        status: { panes: [second.id], session: null },
      })
      expect(app.focused).toBe(second)
      expect(sent.some((event) => event.type === "transcript")).toBe(false)
    } finally {
      finish()
      await runtime.shutdown()
    }
  })

  it("fills a grid of four and refuses a fifth", async () => {
    const { runtime, app } = await setup()
    let finish = () => {}
    try {
      // A busy session is what makes each fresh start a new runtime.
      mocks.executeTurn.mockImplementationOnce(async (options: TurnRunnerOptions) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return turnEvents("done")(options)
      })
      await runtime.sendPrompt("keep working")
      const busy = app.focused
      const fresh = () => {
        runtime.focusSession(busy.id)
        return app.openNew()
      }
      const others = [fresh(), fresh(), fresh(), fresh()]
      await flush()
      for (const entry of others.slice(0, 3)) runtime.openPane(entry.id, "right")
      await flush()
      expect((await runtime.snapshot()).panes).toEqual([
        others[3]?.id,
        ...others.slice(0, 3).map((entry) => entry.id),
      ])
      runtime.openPane(busy.id, "right")
      await flush()
      expect((await runtime.snapshot()).panes).toHaveLength(4)
      expect((await runtime.snapshot()).panes).not.toContain(busy.id)

      // Dropped onto a card, a session from the strip takes that card's place; two on screen
      // trade places.
      const [a, b, c, d] = (await runtime.snapshot()).panes
      runtime.replacePane(a ?? 0, busy.id)
      await flush()
      expect((await runtime.snapshot()).panes).toEqual([busy.id, b, c, d])
      runtime.replacePane(busy.id, d ?? 0)
      await flush()
      expect((await runtime.snapshot()).panes).toEqual([d, b, c, busy.id])

      // Showing only one keeps it as the active session and sends the rest back to the strip.
      const solo = others[1]
      if (!solo) throw new Error("expected a fourth session")
      runtime.soloPane(solo.id)
      await flush()
      expect((await runtime.snapshot()).panes).toEqual([solo.id])
      expect(app.focused).toBe(solo)
    } finally {
      finish()
      await runtime.shutdown()
    }
  })

  it("resets the transcript view when switching sessions", async () => {
    const { runtime } = await setup()
    try {
      mocks.executeTurn.mockImplementation(turnEvents("first session reply"))
      await runtime.sendPrompt("hello")
      await vi.waitFor(async () => {
        const snapshot = await runtime.snapshot()
        expect(snapshot.entries.some((entry) => entry.text === "first session reply")).toBe(true)
        expect(snapshot.busy).toBe(false)
      })

      const sessions = (await runtime.snapshot()).sessions
      expect(sessions).toHaveLength(1)

      const fresh = await runtime.startNewSession()
      expect(fresh.ok).toBe(true)
      await vi.waitFor(async () => expect((await runtime.snapshot()).entries).toHaveLength(0))

      mocks.executeTurn.mockImplementation(turnEvents("second session reply"))
      await runtime.sendPrompt("another")
      await vi.waitFor(async () => {
        const snapshot = await runtime.snapshot()
        expect(snapshot.entries.some((entry) => entry.text === "second session reply")).toBe(true)
        expect(snapshot.busy).toBe(false)
      })

      const listed = (await runtime.snapshot()).sessions
      expect(listed.length).toBe(2)
      const other = listed.find((session) => !session.active)
      if (!other) throw new Error("expected an inactive session in the picker")

      const switched = await runtime.selectSession(other.id)
      expect(switched.ok).toBe(true)
      await vi.waitFor(async () => {
        const snapshot = await runtime.snapshot()
        expect(snapshot.entries.some((entry) => entry.text === "first session reply")).toBe(true)
        expect(snapshot.session?.id).toBe(other.id)
      })
    } finally {
      await runtime.shutdown()
    }
  })
})

describe("DesktopRuntime model selection", () => {
  const localChoice: LocalPickerChoice = {
    kind: "model",
    provider: "local",
    id: "Qwen/Qwen3.8-27B",
    displayName: "Qwen3.8 27B",
    contextLength: 32_768,
    supportsImageInput: false,
    available: true,
    recommended: true,
    availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
    hasDownloadedPacking: true,
    cpuOffload: false,
    downloaded: true,
    active: false,
  }

  async function setupWithCatalog(
    items: ModelPickerItem[],
    {
      configureClient = true,
      pairEndpoints,
    }: { configureClient?: boolean; pairEndpoints?: PairEndpoints } = {},
  ) {
    // Unlike setup() this builds the runtime itself so the catalog seams reach it; sharing one
    // Application between two runtimes would interleave their status events.
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    if (configureClient) {
      app.models.client = fakeClient
      app.models.selectedId = "accounts/fireworks/models/fake"
      app.models.selectedProvider = "fireworks"
    }
    app.fireworksApiKey = "fw-key"
    if (pairEndpoints) app.pairEndpoints = pairEndpoints
    const sent: DesktopEvent[] = []
    const listPickerItems = vi.fn<typeof listModelPickerItems>(async () => items)
    const discoverPair = vi.fn<typeof discoverPairModels>(async () => ({ errors: [] }))
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: (event) => sent.push(event),
      listPickerItems,
      discoverPair,
    })
    return { app, runtime, sent, cwd, listPickerItems, discoverPair }
  }

  it("passes the current selection and credentials through to the catalog", async () => {
    const { runtime, listPickerItems } = await setupWithCatalog([])
    await runtime.listModels()
    expect(listPickerItems).toHaveBeenCalledOnce()
    expect(listPickerItems.mock.calls[0]?.[0]).toMatchObject({
      fireworksApiKey: "fw-key",
      currentModel: "accounts/fireworks/models/fake",
      currentProvider: "fireworks",
      loadStatus: undefined,
    })
    await runtime.shutdown()
  })

  it("discovers PAIR models from saved endpoints and blanks the section when discovery fails", async () => {
    const pairModel: PairCatalogModel = {
      provider: "pair",
      id: "qwen3:32b",
      displayName: "qwen3:32b",
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama",
      supportsImageInput: false,
    }
    const { runtime, listPickerItems, discoverPair } = await setupWithCatalog([], {
      pairEndpoints: { ollama: "http://127.0.0.1:11434" },
    })
    discoverPair.mockResolvedValueOnce({ ollama: [pairModel], lmStudio: [], errors: [] })
    await runtime.listModels()
    expect(listPickerItems.mock.calls[0]?.[0]?.pairModels).toEqual([pairModel])

    discoverPair.mockRejectedValueOnce(new Error("connection refused"))
    await expect(runtime.listModels()).resolves.toEqual([])
    expect(listPickerItems.mock.calls[1]?.[0]?.pairModels).toEqual([])
    await runtime.shutdown()
  })

  it("rejects unknown and unavailable models without touching the model host", async () => {
    const unavailable = {
      ...localChoice,
      available: false as const,
      availabilityLabel: "Needs 48 GB",
    }
    const { runtime, app } = await setupWithCatalog([unavailable])
    const persist = vi.spyOn(app.models, "persistSelection")

    expect(await runtime.selectModel("missing/model")).toEqual({
      ok: false,
      reason: "That model is no longer in the catalog.",
    })
    expect(await runtime.selectModel(localChoice.id)).toEqual({ ok: false, reason: "Needs 48 GB" })
    expect(persist).not.toHaveBeenCalled()
    await runtime.shutdown()
  })

  it("switches models with progress events and persists the choice", async () => {
    const { runtime, app, sent } = await setupWithCatalog([localChoice])
    const prepare = preparing(app, async (options) => {
      options.onLocalProgress?.({ phase: "download", percent: 42 } as never)
      // A real load spans many flush windows; holding here lets the batched status pump deliver
      // the progress row before completion clears it.
      await new Promise((resolve) => setTimeout(resolve, 60))
    })

    const result = await runtime.selectModel(localChoice.id)
    expect(result).toEqual({ ok: true })

    expect(prepare).toHaveBeenCalledOnce()
    const call = prepare.mock.calls[0]
    if (!call) throw new Error("prepare was not called")
    const [preparedModel, prepareOptions] = call
    expect(preparedModel).toMatchObject({ provider: "local", id: localChoice.id })
    expect(prepareOptions.fireworksApiKey).toBe("fw-key")
    // The selection was persisted through the provided hook before commit.
    const saved = await loadLocalSettings()
    expect(saved.model).toBe(localChoice.id)
    expect(saved.modelProvider).toBe("local")

    await flush()
    const statuses = sent.filter((event) => event.type === "status").map((event) => event.status)
    const progress = statuses.find((status) => status.modelLoad?.status.kind === "progress")
    expect(progress?.modelLoad).toEqual({
      modelId: localChoice.id,
      status: { label: "Downloading 42%", kind: "progress" },
    })
    expect(statuses.at(-1)).toMatchObject({ modelLoad: null, modelState: "ready" })
    expect((await runtime.snapshot()).model).toEqual({
      id: localChoice.id,
      provider: "local",
      displayName: "Qwen3.8 27B",
      supportsImageInput: false,
    })
    await runtime.shutdown()
  })

  it("rejects prompts while a model switch is in flight, then admits them again", async () => {
    mocks.executeTurn.mockReset()
    mocks.executeTurn.mockImplementation(turnEvents("after the switch"))
    const { runtime, app } = await setupWithCatalog([localChoice])
    let persistStarted!: () => void
    let releasePersist!: () => void
    const started = new Promise<void>((resolve) => {
      persistStarted = resolve
    })
    preparing(app, async () => {
      persistStarted()
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
    })

    const pending = runtime.selectModel(localChoice.id)
    await started
    const rejected = await runtime.sendPrompt("during the switch")
    expect(rejected).toEqual({
      accepted: false,
      reason: "A model switch is in progress. Try again in a moment.",
    })
    expect(app.transcript.entries).toHaveLength(0)

    releasePersist()
    expect(await pending).toEqual({ ok: true })
    const admitted = await runtime.sendPrompt("after the switch")
    expect(admitted).toEqual({ accepted: true, delivery: "started" })
    await runtime.shutdown()
  })

  it("parks a queued backlog during the switch and drains it afterward", async () => {
    mocks.executeTurn.mockReset()
    mocks.executeTurn.mockImplementation(turnEvents("backlog ran"))
    const { runtime, app } = await setupWithCatalog([localChoice])
    let releasePersist!: () => void
    preparing(app, async () => {
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
    })
    await app.conversation.queue({ role: "user", content: "queued without a driver" })

    const selection = runtime.selectModel(localChoice.id)
    // The backlog stays parked while preparation is in flight.
    await flush()
    expect(mocks.executeTurn).not.toHaveBeenCalled()

    releasePersist()
    expect(await selection).toEqual({ ok: true })
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalledOnce())
    await runtime.shutdown()
  })

  it("defers a follow-up admitted during a model switch until the switch settles", async () => {
    mocks.executeTurn.mockReset()
    const { runtime, app } = await setupWithCatalog([localChoice])

    const turnModels: (string | undefined)[] = []
    let releaseFirst!: () => void
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls += 1
        turnModels.push(app.models.selectedId)
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          return { status: "interrupted", messages: [], details: {} }
        }
        return turnEvents("follow-up ran")(options)
      },
    )

    // Hold the switch inside preparation so the admission can land mid-switch.
    let persistStarted!: () => void
    let releasePersist!: () => void
    const preparationStarted = new Promise<void>((resolve) => {
      persistStarted = resolve
    })
    preparing(app, async () => {
      persistStarted()
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
    })

    // Delay the follow-up's session admission behind a gate, like a slow session write.
    const originalSteer = app.conversation.steer.bind(app.conversation)
    let releaseAdmission!: () => void
    const steer = vi.spyOn(app.conversation, "steer").mockImplementation(async (message) => {
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      return originalSteer(message)
    })

    expect(await runtime.sendPrompt("first")).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(() => expect(app.conversation.busy).toBe(true))
    const followUp = runtime.sendPrompt("follow-up")
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())

    // The first turn finishes with the admission still pending; the driver exits with an empty
    // queue.
    releaseFirst()
    await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))

    // Start the switch, then let the admission land: it must park, not start a turn on the model
    // being replaced.
    const selection = runtime.selectModel(localChoice.id)
    await preparationStarted
    releaseAdmission()
    expect(await followUp).toEqual({ accepted: true, delivery: "queued" })
    await flush()
    expect(calls).toBe(1)

    // Once the switch settles, the parked follow-up runs on the new model.
    releasePersist()
    expect(await selection).toEqual({ ok: true })
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(turnModels).toEqual(["accounts/fireworks/models/fake", localChoice.id])
    await runtime.shutdown()
  })

  it("orders selections by click: a newer click supersedes the older one in flight", async () => {
    const older: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/older",
      displayName: "Older",
      supportsImageInput: false,
      available: true,
      active: false,
    }
    const newer: FireworksPickerChoice = {
      ...older,
      id: "accounts/fireworks/models/newer",
      displayName: "Newer",
    }
    const { runtime, app, listPickerItems } = await setupWithCatalog([older, newer])
    // The picker lists once; clicks resolve against that listing without another fetch, so the
    // second click joins the queue before the first has started and supersedes it.
    await runtime.listModels()
    preparing(app)

    const first = runtime.selectModel(older.id)
    const second = runtime.selectModel(newer.id)
    expect(await first).toEqual({ ok: false, reason: "The selection was superseded." })
    expect(await second).toEqual({ ok: true })
    expect(app.models.selectedId).toBe(newer.id)
    expect(listPickerItems).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })

  it("cancels an in-flight selection and clears its progress", async () => {
    const { runtime, app, sent } = await setupWithCatalog([localChoice])
    vi.spyOn(app.models, "prepare").mockImplementation(
      (_model, options) =>
        new Promise((_resolve, reject) => {
          options.onLocalProgress?.({ phase: "loading" })
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )

    const pending = runtime.selectModel(localChoice.id)
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).modelLoad?.status.label).toBe("Loading")
    })

    await runtime.cancelModelSelection()
    expect(await pending).toEqual({ ok: false, reason: "The selection was cancelled." })
    await flush()
    const last = sent.filter((event) => event.type === "status").at(-1)
    expect(last?.status.modelLoad).toBeNull()
    await runtime.shutdown()
  })
})

describe("DesktopRuntime updates", () => {
  it("exposes updater state in snapshots and events, and only installs a ready update", async () => {
    const install = vi.fn()
    const check = vi.fn()
    const { runtime, sent } = await setup(true, { installUpdate: install, checkForUpdates: check })

    expect((await runtime.snapshot()).update).toEqual({ status: "idle" })
    await runtime.installUpdate()
    expect(install).not.toHaveBeenCalled()
    await runtime.checkForUpdates()
    expect(check).toHaveBeenCalledOnce()
    runtime.setUpdateState({ status: "downloading", version: "9.9.9" })
    expect((await runtime.snapshot()).update).toEqual({ status: "downloading", version: "9.9.9" })
    await runtime.installUpdate()
    expect(install).not.toHaveBeenCalled()
    runtime.setUpdateState({ status: "ready", version: "9.9.9" })
    expect((await runtime.snapshot()).update).toEqual({ status: "ready", version: "9.9.9" })

    await flush()
    const updateEvents = sent.filter(
      (event) => event.type === "status" && event.status.update.status === "ready",
    )
    expect(updateEvents).toHaveLength(1)

    await runtime.installUpdate()
    expect(install).toHaveBeenCalledOnce()
    await runtime.shutdown()
    await runtime.checkForUpdates()
    await runtime.installUpdate()
    expect(check).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
  })
})

describe("update shutdown", () => {
  it("rejects new work once the runtime has shut down for an install", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("reply"))
    await runtime.sendPrompt("hello")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text === "reply")).toBe(true),
    )

    await runtime.shutdown() // installUpdate's first step

    const prompt = await runtime.sendPrompt("too late")
    expect(prompt.accepted).toBe(false)
    if (!prompt.accepted) expect(prompt.reason).toMatch(/restarting/i)
    const selected = await runtime.selectSession("anything")
    expect(selected.ok).toBe(false)
    expect(runtime.startNewSession().ok).toBe(false)
    expect((await runtime.deleteSession("anything")).ok).toBe(false)
    expect((await runtime.switchWorkspace("/tmp")).ok).toBe(false)
  })
})

describe("pending workspace (locate flow)", () => {
  it("opens unregistered history in place: transcript loads, work is blocked until located", async () => {
    const { runtime } = await setup()
    await foreignSession("legacy-deadbeef0001", "legacy-1", "ancient history")

    const opened = await runtime.selectSession("legacy-1", "legacy-deadbeef0001")
    expect(opened.ok).toBe(true)

    const snapshot = await runtime.snapshot()
    expect(snapshot.entries.some((entry) => entry.text === "ancient history")).toBe(true)
    expect(snapshot.needsWorkspace).toBe(true)

    const prompt = await runtime.sendPrompt("continue this")
    expect(prompt.accepted).toBe(false)
    if (!prompt.accepted) expect(prompt.reason).toMatch(/locate/i)
    await runtime.shutdown()
  })

  it("locating the folder registers it and moves the session into the real workspace", async () => {
    const { runtime, cwd } = await setup()
    await foreignSession("legacy-deadbeef0002", "legacy-2", "old work")
    expect((await runtime.selectSession("legacy-2", "legacy-deadbeef0002")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    const located = join(cwd, "..", "located-ws")
    await mkdir(located, { recursive: true })
    const moved = await runtime.locateWorkspace(located)
    expect(moved.ok).toBe(true)

    const snapshot = await runtime.snapshot()
    expect(snapshot.needsWorkspace).toBe(false)
    expect(snapshot.workspace.path).toBe(located)
    expect(snapshot.session?.id).toBe("legacy-2")
    expect(snapshot.entries.some((entry) => entry.text === "old work")).toBe(true)

    // The association persisted: opening again never asks twice.
    expect(await readWorkspacePath(join(sessionRootDirectory(), "legacy-deadbeef0002"))).toBe(
      located,
    )
    await runtime.shutdown()
  })

  it("a missing registered folder falls back to in-place history with the locate banner", async () => {
    const { runtime } = await setup()
    await foreignSession("gone-deadbeef0003", "legacy-3", "folder was deleted")
    await registerWorkspacePath(
      join(sessionRootDirectory(), "gone-deadbeef0003"),
      "/definitely/not/here",
    )

    const opened = await runtime.switchWorkspace(
      "/definitely/not/here",
      "legacy-3",
      "gone-deadbeef0003",
    )
    expect(opened.ok).toBe(true)
    const snapshot = await runtime.snapshot()
    expect(snapshot.entries.some((entry) => entry.text === "folder was deleted")).toBe(true)
    expect(snapshot.needsWorkspace).toBe(true)
    await runtime.shutdown()
  })
})

describe("pending workspace edge cases", () => {
  it("a prompt submitted while foreign history is still opening is rejected, not run in the current folder", async () => {
    const { runtime } = await setup()
    await foreignSession("legacy-gap00000001", "gap-1", "slow open")

    const opening = runtime.selectSession("gap-1", "legacy-gap00000001")
    // The select has started (its guard is held synchronously) but not settled.
    const slipped = await runtime.sendPrompt("sneaky work")
    expect(slipped.accepted).toBe(false)
    if (!slipped.accepted) expect(slipped.reason).toMatch(/opening/i)
    expect((await opening).ok).toBe(true)
    await runtime.shutdown()
  })

  it("a stale row whose workspace was registered after the palette loaded switches into it", async () => {
    const { runtime, cwd } = await setup()
    await foreignSession("stale-aa0000000002", "stale-1", "registered meanwhile")
    // The "palette loaded" here: the dir was unregistered. Another instance registers it before the
    // click.
    const elsewhere = join(cwd, "..", "registered-elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await registerWorkspacePath(join(sessionRootDirectory(), "stale-aa0000000002"), elsewhere)

    const opened = await runtime.selectSession("stale-1", "stale-aa0000000002")
    expect(opened.ok).toBe(true)
    const snapshot = await runtime.snapshot()
    expect(snapshot.workspace.path).toBe(elsewhere) // switched, not opened in the wrong folder
    expect(snapshot.needsWorkspace).toBe(false)
    expect(snapshot.session?.id).toBe("stale-1")
    await runtime.shutdown()
  })

  it("locating to the folder already open relocks the session and lifts the read-only state", async () => {
    const { runtime, cwd } = await setup()
    await foreignSession("legacy-samefolder03", "same-1", "already home")
    expect((await runtime.selectSession("same-1", "legacy-samefolder03")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    const located = await runtime.locateWorkspace(cwd)
    expect(located.ok).toBe(true)
    const snapshot = await runtime.snapshot()
    expect(snapshot.needsWorkspace).toBe(false)
    expect(snapshot.workspace.path).toBe(cwd)
    expect(snapshot.session?.id).toBe("same-1")

    // The write lock is really held again: no second acquirer, and prompts flow.
    await expect(
      acquireSessionLock({
        cwd,
        directory: join(sessionRootDirectory(), "legacy-samefolder03"),
        sessionId: "same-1",
      }),
    ).rejects.toThrow(/already in use/)
    mocks.executeTurn.mockImplementation(turnEvents("back to work"))
    expect((await runtime.sendPrompt("continue")).accepted).toBe(true)
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text === "back to work")).toBe(true),
    )
    await runtime.shutdown()
  })

  it("Open Folder while previewing unknown history switches away without registering the preview", async () => {
    const { runtime, cwd } = await setup()
    await foreignSession("legacy-openfolder04", "prev-1", "just browsing")
    expect((await runtime.selectSession("prev-1", "legacy-openfolder04")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    const somewhere = join(cwd, "..", "somewhere-else")
    await mkdir(somewhere, { recursive: true })
    const opened = await runtime.openWorkspace(somewhere)
    expect(opened.ok).toBe(true)

    const snapshot = await runtime.snapshot()
    expect(snapshot.workspace.path).toBe(somewhere)
    expect(snapshot.needsWorkspace).toBe(false)
    // No silent association: the previewed dir remains unregistered.
    expect(
      await readWorkspacePath(join(sessionRootDirectory(), "legacy-openfolder04")),
    ).toBeUndefined()
    await runtime.shutdown()
  })
})

describe("missing-folder fallback guard", () => {
  it("holds prompts through fallback loading and read-only classification", async () => {
    const { app, runtime } = await setup()
    await foreignSession("gone-fallback0005", "fall-1", "deleted folder history")

    // Gate the fallback's session load so the test can submit a prompt mid-flight.
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = app.sessions.select.bind(app.sessions)
    vi.spyOn(app.sessions, "select").mockImplementation(async (id, storage) => {
      entered()
      await gate
      return original(id, storage)
    })

    const switching = runtime.switchWorkspace("/definitely/not/here", "fall-1", "gone-fallback0005")
    await enteredPromise // the fallback load has started; #switching must still be held

    const slipped = await runtime.sendPrompt("wrong-folder work")
    expect(slipped.accepted).toBe(false)

    release()
    expect((await switching).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)
    await runtime.shutdown()
  })
})

describe("locate race safety", () => {
  it("refuses overlapping session changes while a locate is completing", async () => {
    const { app, runtime, cwd } = await setup()
    await foreignSession("race-aa0000000006", "session-a", "session A history")
    await foreignSession("race-bb0000000007", "session-b", "session B history")
    expect((await runtime.selectSession("session-a", "race-aa0000000006")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    // Hold the locate at the relock step.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const originalRelock = app.sessions.relock.bind(app.sessions)
    vi.spyOn(app.sessions, "relock").mockImplementation(async () => {
      entered()
      await gate
      return originalRelock()
    })

    const locating = runtime.locateWorkspace(cwd)
    await enteredPromise

    // The reproduced step 2: switching to another unknown session mid-locate must be refused.
    const switched = await runtime.selectSession("session-b", "race-bb0000000007")
    expect(switched.ok).toBe(false)
    if (!switched.ok) expect(switched.reason).toMatch(/locating/i)
    expect(runtime.startNewSession().ok).toBe(false)
    expect((await runtime.deleteSession("session-b", "race-bb0000000007")).ok).toBe(false)
    expect((await runtime.switchWorkspace(cwd)).ok).toBe(false)

    release()
    expect((await locating).ok).toBe(true)

    // Only A was recovered: it is current, editable, and no longer read-only.
    const snapshot = await runtime.snapshot()
    expect(snapshot.needsWorkspace).toBe(false)
    expect(snapshot.session?.id).toBe("session-a")
    await runtime.shutdown()
  })

  it("verifies the pending (dirName, sessionId) before restoring write access", async () => {
    const { app, runtime, cwd } = await setup()
    await foreignSession("drift-aa0000000008", "session-a", "session A history")
    await foreignSession("drift-bb0000000009", "session-b", "session B history")
    expect((await runtime.selectSession("session-a", "drift-aa0000000008")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    // State drift underneath the runtime (defense-in-depth path): the coordinator now holds B.
    expect(
      await app.sessions.select("session-b", {
        directory: join(sessionRootDirectory(), "drift-bb0000000009"),
      }),
    ).toBe("loaded")

    const relockSpy = vi.spyOn(app.sessions, "relock")
    const located = await runtime.locateWorkspace(cwd)
    expect(located.ok).toBe(false)
    if (!located.ok) expect(located.reason).toMatch(/changed while locating/i)
    // B was never relocked by the locate, and the read-only restriction was not lifted.
    expect(relockSpy).not.toHaveBeenCalled()
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)
    await app.sessions.releaseLock()
    await runtime.shutdown()
  })
})

describe("locate overlap exclusion", () => {
  it("rejects a locate while a session selection is in flight", async () => {
    const { app, runtime, cwd } = await setup()
    await foreignSession("ord-aa0000000010", "session-a", "session A history")
    await foreignSession("ord-bb0000000011", "session-b", "session B history")
    expect((await runtime.selectSession("session-a", "ord-aa0000000010")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    // Start selecting B and hold it mid-load: the selection began before the locate.
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = app.sessions.select.bind(app.sessions)
    vi.spyOn(app.sessions, "select").mockImplementation(async (id, storage) => {
      entered()
      await gate
      return original(id, storage)
    })

    const selecting = runtime.selectSession("session-b", "ord-bb0000000011")
    await enteredPromise

    const located = await runtime.locateWorkspace(cwd)
    expect(located.ok).toBe(false)
    if (!located.ok) expect(located.reason).toMatch(/still opening/i)

    release()
    expect((await selecting).ok).toBe(true)
    // B's own pending state was computed by its select: still read-only, nothing wrongly unlocked.
    const snapshot = await runtime.snapshot()
    expect(snapshot.needsWorkspace).toBe(true)
    expect(snapshot.session?.id).toBe("session-b")
    // A's marker was never written by the refused locate.
    expect(
      await readWorkspacePath(join(sessionRootDirectory(), "ord-aa0000000010")),
    ).toBeUndefined()
    await runtime.shutdown()
  })

  it("rejects a second locate while the first is still running", async () => {
    const { app, runtime, cwd } = await setup()
    await foreignSession("ord-cc0000000012", "session-a", "session A history")
    expect((await runtime.selectSession("session-a", "ord-cc0000000012")).ok).toBe(true)
    expect((await runtime.snapshot()).needsWorkspace).toBe(true)

    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRelock = app.sessions.relock.bind(app.sessions)
    vi.spyOn(app.sessions, "relock").mockImplementation(async () => {
      entered()
      await gate
      return originalRelock()
    })

    const first = runtime.locateWorkspace(cwd)
    await enteredPromise

    const second = await runtime.locateWorkspace(cwd)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toMatch(/locating/i)

    release()
    expect((await first).ok).toBe(true)
    const snapshot = await runtime.snapshot()
    expect(snapshot.needsWorkspace).toBe(false)
    expect(snapshot.session?.id).toBe("session-a")
    await runtime.shutdown()
  })
})
