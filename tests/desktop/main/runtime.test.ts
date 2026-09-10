import { appendFile, mkdir } from "node:fs/promises"
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
  PairPickerChoice,
} from "../../../src/inference/picker-catalog.js"
import type { ChatMessage, InferenceClient, PairCatalogModel } from "../../../src/inference/types.js"
import { loadLocalSettings, saveSelectedModel } from "../../../src/local/settings.js"
import type { PermissionRequest } from "../../../src/permissions/policy.js"
import {
  acquireSessionLock,
  readWorkspacePath,
  registerWorkspacePath,
  sessionRootDirectory,
} from "../../../src/storage/index.js"
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
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: "Qwen Coder",
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

  it("a model picked during startup supersedes it and is never overwritten by the late startup", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "local",
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: "Qwen Coder",
      contextLength: 32_768,
      supportsImageInput: false,
    })

    const app = await Application.create({ cwd })
    const fireworksChoice: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      supportsImageInput: false,
      available: true,
      active: false,
    }
    const prepare = vi.spyOn(app.models, "prepare").mockImplementation(async (model, options) => {
      if (model.provider === "local") {
        // The saved model's startup is slow like a long download; a real prepare rejects when aborted. If nothing
        // aborts it, it commits late — over any selection made in the meantime.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100)
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        })
      }
      return { model, commit: () => app.models.activate(model, fakeClient), rollback: async () => {} }
    })
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listPickerItems: async () => [fireworksChoice],
      discoverPair: async () => ({ errors: [] }),
    })
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())

    const result = await runtime.selectModel(fireworksChoice.id)
    expect(result).toEqual({ ok: true })

    // The aborted startup must not reactivate the saved local model over the user's newer pick; wait past the
    // point its slow prepare would commit if nothing had superseded it.
    await app.models.waitForSelection()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(app.models.selectedId).toBe(fireworksChoice.id)
    expect(app.models.client).toBe(fakeClient)
    const snapshot = await runtime.snapshot()
    expect(snapshot.modelState).toBe("ready")
    expect(snapshot.model?.id).toBe(fireworksChoice.id)
    expect((await loadLocalSettings()).model).toBe(fireworksChoice.id)
    await runtime.shutdown()
  })

  it("selecting the failed saved model retries preparation instead of reporting false success", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    await saveSelectedModel({
      provider: "local",
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: "Qwen Coder",
      contextLength: 32_768,
      supportsImageInput: false,
    })

    const app = await Application.create({ cwd })
    const activeRow: LocalPickerChoice = {
      kind: "model",
      provider: "local",
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: "Qwen Coder",
      contextLength: 32_768,
      supportsImageInput: false,
      available: true,
      recommended: true,
      availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
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

    const persist = vi.spyOn(app.models, "persistSelection").mockImplementation(async (model, options) => {
      await options.persist(model)
      app.models.activate(model, fakeClient)
      return model
    })
    const result = await runtime.selectModel(activeRow.id)
    expect(result).toEqual({ ok: true })
    expect(persist).toHaveBeenCalledOnce()
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
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
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
    })

    expect(await runtime.sendPrompt("delegate something")).toEqual({ accepted: true, delivery: "started" })
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
    expect(finished).toMatchObject({ toolCallId: "call_scout", title: "Scout the repo", status: "complete", tools: 1 })
    expect(finished?.durationMs).toBeGreaterThanOrEqual(0)

    const trace = await runtime.getSubagentTrace("call_scout")
    expect(trace.some((entry) => entry.kind === "tool" && entry.text.includes("Reading files"))).toBe(true)
    expect(trace.some((entry) => entry.text === "Found it.")).toBe(true)
    expect(await runtime.getSubagentTrace("missing")).toEqual([])
    await runtime.shutdown()
  })

  it("applies and persists the theme and thinking preferences", async () => {
    const { runtime, sent } = await setup()
    expect((await runtime.snapshot()).theme).toBe("default")
    expect((await runtime.snapshot()).thinkingVisible).toBe(false)

    await runtime.setTheme("nord")
    expect((await runtime.snapshot()).theme).toBe("nord")
    expect((await loadLocalSettings()).theme).toBe("nord")
    await flush()
    expect(sent.some((event) => event.type === "status" && event.status.theme === "nord")).toBe(true)

    await runtime.setTheme("not-a-theme")
    expect((await runtime.snapshot()).theme).toBe("nord")

    await runtime.setThinkingVisible(true)
    expect((await runtime.snapshot()).thinkingVisible).toBe(true)
    expect((await loadLocalSettings()).thinkingVisible).toBe(true)
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
    const runtime = DesktopRuntime.forApplication(app, { cwd, version: "test", platform: "darwin", send: () => {} })

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

  it("validates and activates a Fireworks API key", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    app.models.client = fakeClient
    app.models.selectedId = "accounts/fireworks/models/fake"
    app.models.selectedProvider = "fireworks"
    const listToolCapableModels = vi.fn(async () => [{ id: "kimi" }])
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listToolCapableModels: listToolCapableModels as never,
    })

    expect(await runtime.setFireworksApiKey("  ")).toEqual({ ok: false, reason: "Fireworks API key is required." })
    expect(listToolCapableModels).not.toHaveBeenCalled()
    expect((await runtime.snapshot()).hostedConfigured).toBe(false)

    listToolCapableModels.mockRejectedValueOnce(new Error("Could not load Fireworks models (HTTP 401): bad key"))
    expect(await runtime.setFireworksApiKey("bad-key")).toEqual({
      ok: false,
      reason: "Could not load Fireworks models (HTTP 401): bad key",
    })
    expect((await loadLocalSettings()).fireworksApiKey).toBeUndefined()

    expect(await runtime.setFireworksApiKey(" good-key ")).toEqual({ ok: true })
    expect(app.fireworksApiKey).toBe("good-key")
    expect((await loadLocalSettings()).fireworksApiKey).toBe("good-key")
    // A live hosted selection is rebuilt onto the new key.
    expect(app.models.client).not.toBe(fakeClient)
    expect(app.models.client?.model).toBe("accounts/fireworks/models/fake")
    expect((await runtime.snapshot()).hostedConfigured).toBe(true)
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

    expect(await runtime.connectPairEndpoints({})).toEqual({
      ok: false,
      reason: "Enter at least one NVIDIA PAIR endpoint.",
    })
    expect(await runtime.connectPairEndpoints({ ollama: "https://example.com" })).toEqual({
      ok: false,
      reason: "PAIR endpoint must use HTTP on 127.0.0.1, localhost, or ::1.",
    })

    discoverPair.mockResolvedValueOnce({ errors: [{ engine: "ollama", message: "down" }] } as never)
    expect(await runtime.connectPairEndpoints({ ollama: "http://127.0.0.1:11434" })).toEqual({
      ok: false,
      reason: "NVIDIA PAIR was not found. Start PAIR, enable Ollama or LM Studio, then copy its local endpoint here.",
    })

    const result = await runtime.connectPairEndpoints({ ollama: "http://127.0.0.1:11434/" })
    expect(result).toEqual({ ok: true })
    expect(app.pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    const snapshot = await runtime.snapshot()
    expect(snapshot.pairConfigured).toBe(true)
    expect(snapshot.pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    expect((await loadLocalSettings()).pairEndpoints).toEqual({ ollama: "http://127.0.0.1:11434" })
    await runtime.shutdown()
  })

  it("deletes the active local model and clears the selection", async () => {
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
    const stop = vi.spyOn(app.models.llama, "stop").mockResolvedValue(undefined)
    mocks.listDownloaded.mockResolvedValue([findLocalModel("openai/gpt-oss-20b")])
    const runtime = DesktopRuntime.forApplication(app, { cwd, version: "test", platform: "darwin", send: () => {} })

    const listed = await runtime.listDownloadedModels()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.active).toBe(true)
    expect(listed[0]?.detail).toContain("Active · ")

    const result = await runtime.deleteLocalModel("openai/gpt-oss-20b")
    expect(result).toEqual({ ok: true })
    expect(mocks.deleteGguf).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalled()
    expect(app.models.selectedId).toBeUndefined()
    expect(app.models.client).toBeUndefined()
    const snapshot = await runtime.snapshot()
    expect(snapshot.model).toBeNull()
    expect(snapshot.modelState).toBe("unconfigured")
    expect((await loadLocalSettings()).model).toBeUndefined()
    await runtime.shutdown()
  })

  it("restores the active local model when deletion fails", async () => {
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
    const restore = vi.spyOn(app.models, "restorePrevious").mockResolvedValue(undefined)
    mocks.listDownloaded.mockResolvedValue([findLocalModel("openai/gpt-oss-20b")])
    mocks.deleteGguf.mockRejectedValueOnce(new Error("disk busy"))
    const runtime = DesktopRuntime.forApplication(app, { cwd, version: "test", platform: "darwin", send: () => {} })

    const result = await runtime.deleteLocalModel("openai/gpt-oss-20b")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("Could not delete")
    // The cleared selection is rolled back.
    expect((await loadLocalSettings()).model).toBe("openai/gpt-oss-20b")
    expect(restore).toHaveBeenCalled()
    expect(app.models.selectedId).toBe("openai/gpt-oss-20b")
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
    if (!prompt.accepted) expect(prompt.reason).toBe("A model switch is in progress. Try again in a moment.")
    expect(await runtime.selectModel(fireworksChoice.id)).toEqual({
      ok: false,
      reason: "Finish the current work before switching models.",
    })

    releaseDelete()
    expect(await pending).toEqual({ ok: true })
    expect(app.models.selectedId).toBeUndefined()
    await runtime.shutdown()
  })

  it("rejects deletion while a selection is in flight", async () => {
    const home = await isolate("otis-desktop-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    app.models.client = fakeClient
    app.models.selectedId = "accounts/fireworks/models/fake"
    app.models.selectedProvider = "fireworks"
    const kimi: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi",
      displayName: "Kimi",
      supportsImageInput: false,
      available: true,
      active: false,
    }
    // The prepare only settles when the selection is aborted, so the switch stays in flight until cancelled.
    vi.spyOn(app.models, "prepare").mockImplementation(
      async (_model, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }) as never,
    )
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      listPickerItems: async () => [kimi],
      discoverPair: async () => ({ errors: [] }),
    })
    mocks.listDownloaded.mockResolvedValue([findLocalModel("openai/gpt-oss-20b")])

    const selecting = runtime.selectModel(kimi.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await runtime.deleteLocalModel("openai/gpt-oss-20b")).toEqual({
      ok: false,
      reason: "Finish the current work before deleting a model.",
    })
    await runtime.cancelModelSelection()
    await selecting
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
    expect(await runtime.connectPairEndpoints({ ollama: "http://127.0.0.1:11435" })).toEqual({ ok: true })
    expect(app.models.client).not.toBe(oldClient)
    expect((await runtime.snapshot()).modelState).toBe("ready")

    // Reconnect with only the other engine responding: the orphaned selection is invalidated.
    discoverPair.mockResolvedValueOnce({ lmStudio: [lmModel], errors: [] } as never)
    expect(await runtime.connectPairEndpoints({ lmStudio: "http://127.0.0.1:1234" })).toEqual({ ok: true })
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
    const runtime = DesktopRuntime.forApplication(app, { cwd, version: "test", platform: "darwin", send: () => {} })

    // No picker fetch has happened; the persisted fast id alone makes the toggle available.
    const snapshot = await runtime.snapshot()
    expect(snapshot.fastServing).toEqual({ available: true, enabled: false })
    expect(snapshot.model?.displayName).toBe("Kimi")
    await runtime.shutdown()
  })

  it("keeps queued work parked while no model is usable and resumes it once one is ready", async () => {
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
    const kimi: FireworksPickerChoice = {
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
      listPickerItems: async () => [kimi],
      discoverPair: async () => ({ errors: [] }),
    })

    // A parked follow-up: admitted to the session, waiting for a driver.
    await app.conversation.queue({ role: "user", content: "hold this" })
    expect(app.conversation.peekQueued()).toBeTruthy()

    // Deleting the active model leaves no usable client; the settle must not drain the queue into the void.
    expect(await runtime.deleteLocalModel("openai/gpt-oss-20b")).toEqual({ ok: true })
    expect(app.models.client).toBeUndefined()
    expect(app.conversation.peekQueued()).toBeTruthy()
    expect(mocks.executeTurn).not.toHaveBeenCalled()

    // Once a selection commits, the parked follow-up resumes on the new model.
    vi.spyOn(app.models, "prepare").mockImplementation(async (model) => ({
      model,
      commit: () => app.models.activate(model, fakeClient),
      rollback: async () => {},
    }))
    expect(await runtime.selectModel(kimi.id)).toEqual({ ok: true })
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalled())
    expect(app.conversation.peekQueued()).toBeUndefined()
    const ran = mocks.executeTurn.mock.calls.map((call) => JSON.stringify(call[0]).includes("hold this"))
    expect(ran.some(Boolean)).toBe(true)
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

  it("reports no runs for a turn without delegation", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("plain answer"))
    expect(await runtime.sendPrompt("hi")).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).entries.some((entry) => entry.text === "plain answer")).toBe(true)
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

  it("drains queued follow-ups through the conversation after the active turn settles", async () => {
    const { runtime, app } = await setup()

    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      calls += 1
      const turn = calls
      // Close the steering inbox so the follow-up is queued instead of steered.
      await options.agent.steering?.drainOrClose()
      if (turn === 1) await gate
      await options.onEvent?.({ type: "delta", text: `reply ${turn}` })
      const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text: `reply ${turn}` }] }]
      await options.onEvent?.({ type: "complete", messages })
      return { status: "complete", messages, details: {} }
    })

    const first = await runtime.sendPrompt("first")
    expect(first).toEqual({ accepted: true, delivery: "started" })

    const second = await runtime.sendPrompt("second")
    expect(second).toEqual({ accepted: true, delivery: "queued" })
    expect(calls).toBe(1)

    releaseFirst()
    await vi.waitFor(() => expect(calls).toBe(2))

    await vi.waitFor(async () => {
      const snapshot = await runtime.snapshot()
      expect(snapshot.busy).toBe(false)
      expect(snapshot.entries.some((entry) => entry.text === "reply 2")).toBe(true)
    })
    const userEntries = app.transcript.entries.filter((entry) => entry.speaker === "You")
    expect(userEntries.map((entry) => entry.text)).toEqual(["first", "second"])
    expect(userEntries.every((entry) => entry.delivery === undefined)).toBe(true)
    await runtime.shutdown()
  })

  it("reports submission as rejected when session admission fails", async () => {
    const { runtime, app } = await setup()
    vi.spyOn(app.sessions, "ensure").mockRejectedValue(new Error("disk full"))
    mocks.executeTurn.mockImplementation(turnEvents("unreachable"))

    const result = await runtime.sendPrompt("hello")
    expect(result.accepted).toBe(false)
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    // The failure is visible in the transcript, and no user message was recorded.
    expect(app.transcript.entries.some((entry) => entry.speaker === "You")).toBe(false)
    expect(app.transcript.entries.some((entry) => entry.text.includes("disk full"))).toBe(true)
    await runtime.shutdown()
  })

  it("routes permission requests to the GUI and ignores stale replies", async () => {
    const { runtime } = await setup()

    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      const request: PermissionRequest = {
        call: { name: "bash", input: { command: "bun test" } },
        decision: { effect: "ask", resources: ["bun test"] },
      }
      const allowed = await options.agent.onPermissionRequest?.(request)
      const text = allowed ? "allowed" : "denied"
      const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text }] }]
      await options.onEvent?.({ type: "delta", text })
      await options.onEvent?.({ type: "complete", messages })
      return { status: "complete", messages, details: {} }
    })

    const sendTask = runtime.sendPrompt("run the tests")
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).permission).toMatchObject({ label: "Running command: bun test" })
    })

    // A stale id is ignored and must not resolve the pending request.
    await runtime.respondToPermission(999_999, true)
    const pending = (await runtime.snapshot()).permission
    if (!pending) throw new Error("expected a pending permission request")
    await runtime.respondToPermission(pending.id, false)

    await sendTask
    await vi.waitFor(async () => {
      const snapshot = await runtime.snapshot()
      expect(snapshot.permission).toBeNull()
      expect(snapshot.entries.some((entry) => entry.text === "denied")).toBe(true)
    })
    await runtime.shutdown()
  })

  it("denies an unanswered permission request on shutdown", async () => {
    const { runtime } = await setup()
    let observed: boolean | undefined
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      const request: PermissionRequest = {
        call: { name: "bash", input: { command: "rm -rf build" } },
        decision: { effect: "ask", resources: ["rm -rf build"] },
      }
      observed = await options.agent.onPermissionRequest?.(request)
      return { status: "interrupted", messages: [], details: {} }
    })

    const sendTask = runtime.sendPrompt("clean the build")
    await vi.waitFor(async () => expect((await runtime.snapshot()).permission).not.toBeNull())
    await runtime.shutdown()
    await sendTask
    expect(observed).toBe(false)
  })
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const completed = (): TurnResult => ({
  status: "complete",
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  details: {},
})

describe("DesktopRuntime cancellation and timing", () => {
  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  it("does not start queued work after the renderer crashes", async () => {
    const { runtime } = await setup()
    let calls = 0
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
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
    })
    try {
      await runtime.sendPrompt("first")
      expect(await runtime.sendPrompt("second")).toMatchObject({ accepted: true, delivery: "queued" })
      runtime.handleRendererGone()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(calls).toBe(1)
    } finally {
      await runtime.shutdown()
    }
  })

  it("resumes the suspended queue only when the user sends again, preserving order", async () => {
    const { runtime, app } = await setup()
    let calls = 0
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
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
    })
    try {
      await runtime.sendPrompt("first")
      await runtime.sendPrompt("second")
      runtime.handleRendererGone()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(calls).toBe(1)

      expect(await runtime.sendPrompt("third")).toMatchObject({ accepted: true, delivery: "queued" })
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
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
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
    })
    try {
      await runtime.sendPrompt("first")
      await runtime.sendPrompt("second")
      runtime.handleRendererGone()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(calls).toBe(1)

      // The resuming prompt cannot be admitted (disk failure): it is rejected and "second" stays queued.
      vi.spyOn(app.sessions, "ensure").mockRejectedValueOnce(new Error("disk full"))
      expect((await runtime.sendPrompt("third")).accepted).toBe(false)
      expect(calls).toBe(1)

      // A later send drains the backlog ahead of itself, in order.
      expect(await runtime.sendPrompt("fourth")).toMatchObject({ accepted: true, delivery: "queued" })
      await vi.waitFor(() => expect(calls).toBe(3))
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      const userEntries = app.transcript.entries.filter((entry) => entry.speaker === "You")
      expect(userEntries.map((entry) => entry.text)).toEqual(["first", "second", "fourth"])
    } finally {
      await runtime.shutdown()
    }
  })

  it("drains a follow-up whose admission finished after its predecessor completed", async () => {
    const { app, runtime } = await setup()
    const finishFirst = gate()
    const permitAdmission = gate()
    const admissionStarted = gate()
    let calls = 0
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      calls++
      await options.agent.steering?.drainOrClose()
      if (calls === 1) await finishFirst.promise
      return completed()
    })
    try {
      await runtime.sendPrompt("first")
      const ensure = app.sessions.ensure.bind(app.sessions)
      vi.spyOn(app.sessions, "ensure").mockImplementation(async () => {
        admissionStarted.resolve()
        await permitAdmission.promise
        return ensure()
      })
      const followup = runtime.sendPrompt("second")
      await admissionStarted.promise
      finishFirst.resolve()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      permitAdmission.resolve()
      expect(await followup).toMatchObject({ accepted: true, delivery: "queued" })
      await vi.waitFor(() => expect(calls).toBe(2), { timeout: 500 })
    } finally {
      finishFirst.resolve()
      permitAdmission.resolve()
      await runtime.shutdown()
    }
  })

  it("clears the approval card when Stop cancels its turn", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      await options.agent.onPermissionRequest?.({
        call: { name: "bash", input: { command: "echo test" } },
        decision: { effect: "ask", resources: ["echo test"] },
      })
      return { status: "interrupted", messages: [], details: {} }
    })
    try {
      await runtime.sendPrompt("request approval")
      await vi.waitFor(async () => expect((await runtime.snapshot()).permission).not.toBeNull())
      runtime.stop()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect((await runtime.snapshot()).permission).toBeNull()
    } finally {
      await runtime.shutdown()
    }
  })
})

describe("DesktopRuntime sessions", () => {
  it("resets the transcript view when switching sessions", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("first session reply"))
    await runtime.sendPrompt("hello")
    await vi.waitFor(async () => expect((await runtime.snapshot()).entries.length).toBeGreaterThan(1))
    await flush()

    const sessions = (await runtime.snapshot()).sessions
    expect(sessions).toHaveLength(1)

    const fresh = await runtime.startNewSession()
    expect(fresh.ok).toBe(true)
    await vi.waitFor(async () => expect((await runtime.snapshot()).entries).toHaveLength(0))

    mocks.executeTurn.mockImplementation(turnEvents("second session reply"))
    await runtime.sendPrompt("another")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((entry) => entry.text === "second session reply")).toBe(true),
    )
    await flush()

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
    await runtime.shutdown()
  })
})

describe("DesktopRuntime model selection", () => {
  const localChoice: LocalPickerChoice = {
    kind: "model",
    provider: "local",
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    displayName: "Qwen Coder",
    contextLength: 32_768,
    supportsImageInput: false,
    available: true,
    recommended: true,
    availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
    downloaded: true,
    active: false,
  }

  async function setupWithCatalog(
    items: ModelPickerItem[],
    { configureClient = true, pairEndpoints }: { configureClient?: boolean; pairEndpoints?: PairEndpoints } = {},
  ) {
    // Unlike setup() this builds the runtime itself so the catalog seams reach it; sharing one Application between
    // two runtimes would interleave their status events.
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

  it("rejects a selection while a turn is running", async () => {
    const { runtime, app } = await setupWithCatalog([localChoice])
    let release!: () => void
    mocks.executeTurn.mockImplementation(
      () =>
        new Promise<TurnResult>((resolve) => {
          release = () => resolve({ status: "interrupted", messages: [], details: {} })
        }),
    )
    const admitted = await runtime.sendPrompt("hold")
    expect(admitted).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(() => expect(app.conversation.busy).toBe(true))

    const result = await runtime.selectModel(localChoice.id)
    expect(result).toEqual({ ok: false, reason: "Finish the current work before switching models." })
    release()
    await runtime.shutdown()
  })

  it("rejects unknown and unavailable models without touching the model host", async () => {
    const unavailable = { ...localChoice, available: false as const, availabilityLabel: "Needs 48 GB" }
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
    const persist = vi.spyOn(app.models, "persistSelection").mockImplementation(async (model, options) => {
      options.onLocalProgress?.({ phase: "download", percent: 42 })
      // A real load spans many flush windows; holding here lets the batched status pump deliver the progress row
      // before completion clears it.
      await new Promise((resolve) => setTimeout(resolve, 60))
      await options.persist(model)
      app.models.activate(model, fakeClient)
      return model
    })

    const result = await runtime.selectModel(localChoice.id)
    expect(result).toEqual({ ok: true })

    expect(persist).toHaveBeenCalledOnce()
    const call = persist.mock.calls[0]
    if (!call) throw new Error("persistSelection was not called")
    const [persistedModel, persistOptions] = call
    expect(persistedModel).toMatchObject({ provider: "local", id: localChoice.id })
    expect(persistOptions.fireworksApiKey).toBe("fw-key")
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
      displayName: "Qwen Coder",
    })
    await runtime.shutdown()
  })

  it("keeps a restored previous model ready and leaves the failure on the picker row", async () => {
    const { runtime, app, sent } = await setupWithCatalog([localChoice])
    vi.spyOn(app.models, "persistSelection").mockRejectedValue(new Error("server did not start"))

    const result = await runtime.selectModel(localChoice.id)
    expect(result).toEqual({ ok: false, reason: "server did not start" })

    await flush()
    const last = sent.filter((event) => event.type === "status").at(-1)
    expect(last?.status.modelState).toBe("ready")
    expect(last?.status.modelLoad).toEqual({
      modelId: localChoice.id,
      status: { label: "Failed: server did not start", kind: "error" },
    })
    await runtime.shutdown()
  })

  it("reports a failed first selection as modelState failed", async () => {
    const { runtime, app } = await setupWithCatalog([localChoice], { configureClient: false })
    vi.spyOn(app.models, "persistSelection").mockRejectedValue(new Error("out of memory"))

    const result = await runtime.selectModel(localChoice.id)
    expect(result).toEqual({ ok: false, reason: "out of memory" })
    const snapshot = await runtime.snapshot()
    expect(snapshot.modelState).toBe("failed")
    expect(snapshot.modelError).toBe("out of memory")
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
    vi.spyOn(app.models, "persistSelection").mockImplementation(async (model, options) => {
      persistStarted()
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
      await options.persist(model)
      app.models.activate(model, fakeClient)
      return model
    })

    const pending = runtime.selectModel(localChoice.id)
    await started
    const rejected = await runtime.sendPrompt("during the switch")
    expect(rejected).toEqual({ accepted: false, reason: "A model switch is in progress. Try again in a moment." })
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
    vi.spyOn(app.models, "persistSelection").mockImplementation(async (model, options) => {
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
      await options.persist(model)
      app.models.activate(model, fakeClient)
      return model
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
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      calls += 1
      turnModels.push(app.models.selectedId)
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return { status: "interrupted", messages: [], details: {} }
      }
      return turnEvents("follow-up ran")(options)
    })

    // Hold the switch inside preparation so the admission can land mid-switch.
    let persistStarted!: () => void
    let releasePersist!: () => void
    const preparationStarted = new Promise<void>((resolve) => {
      persistStarted = resolve
    })
    vi.spyOn(app.models, "persistSelection").mockImplementation(async (model, options) => {
      persistStarted()
      await new Promise<void>((resolve) => {
        releasePersist = resolve
      })
      await options.persist(model)
      app.models.activate(model, fakeClient)
      return model
    })

    // Delay the follow-up's session admission behind a gate, like a slow session write.
    const originalSteer = app.conversation.steer.bind(app.conversation)
    let releaseAdmission!: () => void
    const steer = vi.spyOn(app.conversation, "steer").mockImplementation(async (message, onActivated) => {
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      return originalSteer(message, onActivated)
    })

    expect(await runtime.sendPrompt("first")).toEqual({ accepted: true, delivery: "started" })
    await vi.waitFor(() => expect(app.conversation.busy).toBe(true))
    const followUp = runtime.sendPrompt("follow-up")
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())

    // The first turn finishes with the admission still pending; the driver exits with an empty queue.
    releaseFirst()
    await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))

    // Start the switch, then let the admission land: it must park, not start a turn on the model being replaced.
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

  it("orders selections by click, not by catalog speed", async () => {
    const older: FireworksPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/older",
      displayName: "Older",
      supportsImageInput: false,
      available: true,
      active: false,
    }
    const newer: FireworksPickerChoice = { ...older, id: "accounts/fireworks/models/newer", displayName: "Newer" }
    const { runtime, app, listPickerItems } = await setupWithCatalog([older, newer])
    // The older click's catalog lookup is the slow one; without queue-ordered lookups it would win the queue.
    listPickerItems.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return [older, newer]
    })
    vi.spyOn(app.models, "persistSelection").mockImplementation(async (model) => {
      app.models.activate(model, fakeClient)
      return model
    })

    const first = runtime.selectModel(older.id)
    const second = runtime.selectModel(newer.id)
    expect(await first).toEqual({ ok: false, reason: "The selection was superseded." })
    expect(await second).toEqual({ ok: true })
    expect(app.models.selectedId).toBe(newer.id)
    await runtime.shutdown()
  })

  it("shortcuts the active model only while a client is live", async () => {
    const { runtime, app } = await setupWithCatalog([{ ...localChoice, active: true }])
    const persist = vi.spyOn(app.models, "persistSelection")

    expect(await runtime.selectModel(localChoice.id)).toEqual({ ok: true })
    expect(persist).not.toHaveBeenCalled()
    await runtime.shutdown()
  })

  it("reports a PAIR selection failure on the engine-qualified row", async () => {
    const pairItem: PairPickerChoice = {
      kind: "model",
      provider: "pair",
      id: "qwen3:32b",
      displayName: "qwen3:32b",
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama",
      supportsImageInput: false,
      available: true,
      active: false,
      selectionKey: "pair:ollama:qwen3:32b",
    }
    const { runtime, app, sent } = await setupWithCatalog([pairItem])
    vi.spyOn(app.models, "persistSelection").mockRejectedValue(new Error("endpoint went away"))

    const result = await runtime.selectModel(pairItem.selectionKey)
    expect(result).toEqual({ ok: false, reason: "endpoint went away" })

    await flush()
    const last = sent.filter((event) => event.type === "status").at(-1)
    expect(last?.status.modelLoad).toEqual({
      modelId: "pair:ollama:qwen3:32b",
      status: { label: "Failed: endpoint went away", kind: "error" },
    })
    await runtime.shutdown()
  })

  it("cancels an in-flight selection and clears its progress", async () => {
    const { runtime, app, sent } = await setupWithCatalog([localChoice])
    vi.spyOn(app.models, "persistSelection").mockImplementation(
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
  it("exposes a downloaded update in the snapshot, emits it once, and delegates install", async () => {
    const install = vi.fn()
    const { runtime, sent } = await setup(true, { installUpdate: install })

    expect((await runtime.snapshot()).update).toBeUndefined()
    runtime.setUpdateAvailable("9.9.9")
    expect((await runtime.snapshot()).update).toEqual({ version: "9.9.9" })
    runtime.setUpdateAvailable("9.9.9") // same version again: no duplicate emit

    await flush()
    const updateEvents = sent.filter((event) => event.type === "status" && "update" in event.status)
    expect(updateEvents).toHaveLength(1)

    runtime.installUpdate()
    expect(install).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })
})

describe("update shutdown", () => {
  it("rejects new work once the runtime has shut down for an install", async () => {
    const { runtime } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("reply"))
    await runtime.sendPrompt("hello")
    await vi.waitFor(async () => expect((await runtime.snapshot()).entries.some((e) => e.text === "reply")).toBe(true))

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
    expect(await readWorkspacePath(join(sessionRootDirectory(), "legacy-deadbeef0002"))).toBe(located)
    await runtime.shutdown()
  })

  it("a missing registered folder falls back to in-place history with the locate banner", async () => {
    const { runtime } = await setup()
    await foreignSession("gone-deadbeef0003", "legacy-3", "folder was deleted")
    await registerWorkspacePath(join(sessionRootDirectory(), "gone-deadbeef0003"), "/definitely/not/here")

    const opened = await runtime.switchWorkspace("/definitely/not/here", "legacy-3", "gone-deadbeef0003")
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
    // The "palette loaded" here: the dir was unregistered. Another instance registers it before the click.
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
      acquireSessionLock({ cwd, directory: join(sessionRootDirectory(), "legacy-samefolder03"), sessionId: "same-1" }),
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
    expect(await readWorkspacePath(join(sessionRootDirectory(), "legacy-openfolder04"))).toBeUndefined()
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
      await app.sessions.select("session-b", { directory: join(sessionRootDirectory(), "drift-bb0000000009") }),
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
    expect(await readWorkspacePath(join(sessionRootDirectory(), "ord-aa0000000010"))).toBeUndefined()
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
