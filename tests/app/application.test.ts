import { beforeEach, describe, expect, it, vi } from "vitest"
import { type AppEvent, Application, formatWorkspaceLabel } from "../../src/app/application.js"
import { SESSION_REASONS } from "../../src/app/sessions.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import { findLocalModel } from "../../src/inference/local-catalog.js"
import type {
  FireworksPickerChoice,
  LocalPickerChoice,
  PairPickerChoice,
} from "../../src/inference/picker-catalog.js"
import type { ChatMessage, InferenceClient } from "../../src/inference/types.js"
import { loadLocalSettings, saveSelectedModel } from "../../src/local/settings.js"
import type { PermissionRequest } from "../../src/permissions/policy.js"
import { createSession, listSessions } from "../../src/storage/session.js"
import { acquireSessionLock } from "../../src/storage/session-lock.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({
  executeTurn: vi.fn(),
  listDownloaded: vi.fn<() => Promise<unknown[]>>(async () => []),
  deleteGguf: vi.fn<() => Promise<void>>(async () => {}),
  listToolCapableModels: vi.fn<() => Promise<unknown[]>>(async () => []),
}))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../src/inference/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/inference/client.js")>()),
  listToolCapableModels: mocks.listToolCapableModels,
}))
vi.mock("../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/inference/gguf-cache.js")>()
  return {
    ...original,
    isLocalGgufDownloaded: async () => false,
    listDownloadedLocalModels: mocks.listDownloaded,
    deleteLocalGguf: mocks.deleteGguf,
  }
})

const isolate = useOtisHome()
const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

function turnEvents(text: string) {
  return async (options: TurnRunnerOptions): Promise<TurnResult> => {
    await options.onEvent?.({ type: "delta", text })
    const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text }] }]
    await options.onEvent?.({ type: "complete", messages })
    return { status: "complete", messages, details: {} }
  }
}

/** A real application with a live fake client, the way the desktop suites build one. */
async function ready(prefix = "otis-app-ready-") {
  const app = await Application.create({ cwd: await isolate(prefix), env: {} })
  app.models.client = fakeClient
  app.models.selectedId = "accounts/fireworks/models/fake"
  app.models.selectedProvider = "fireworks"
  return app
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Stands in for model preparation: the selection commits by activating the fake client. */
function preparing(app: Application, during?: (signal: AbortSignal) => Promise<void>) {
  return vi.spyOn(app.models, "prepare").mockImplementation(async (model, options) => {
    await during?.(options.signal)
    return {
      model,
      commit: () => app.models.activate(model, fakeClient),
      rollback: async () => {},
    }
  })
}

const savedLocal = {
  provider: "local" as const,
  id: "Qwen/Qwen3.8-27B",
  displayName: "Qwen3.8 27B",
  contextLength: 32_768,
  supportsImageInput: false,
}
const localChoice: LocalPickerChoice = {
  kind: "model",
  ...savedLocal,
  available: true,
  recommended: true,
  availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
  hasDownloadedPacking: true,
  cpuOffload: false,
  downloaded: true,
  active: false,
}
const kimiChoice: FireworksPickerChoice = {
  kind: "model",
  provider: "fireworks",
  id: "accounts/fireworks/models/kimi",
  displayName: "Kimi",
  supportsImageInput: false,
  available: true,
  active: false,
}

describe("Application", () => {
  it("retains observed context during input refreshes and resets it for another model or session", async () => {
    const home = await isolate("otis-app-context-")
    const app = await Application.create({ cwd: home, env: {} })
    const client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    app.models.client = client
    const pending = { role: "user" as const, content: "next prompt" }
    app.transcript.observeContext(client, 90_000)
    expect(app.contextTokens()).toBe(90_000)
    expect(app.contextTokens(pending)).toBe(
      90_000 + app.contextEstimator()([pending]) - app.contextEstimator()([]),
    )
    app.models.client = { ...client }
    expect(app.contextTokens()).toBe(app.contextEstimator()([]))
    app.models.client = client
    app.transcript.loadCompacted("Summary.", [])
    expect(app.contextTokens()).toBe(app.contextEstimator()(app.transcript.history))
    app.transcript.observeContext(client, 90_000)
    app.sessions.startNew()
    expect(app.contextTokens()).toBe(app.contextEstimator()([]))
    await app.shutdown()
  })

  it("composes workspace, session, and model coordinators without a frontend", async () => {
    const home = await isolate("otis-app-")

    const app = await Application.create({
      cwd: home,
      env: { FIREWORKS_API_KEY: "fw_test" },
    })

    expect(app.cwd).toBe(home)
    expect(app.fireworksApiKey).toBe("fw_test")
    expect(app.settings.model).toBeUndefined()
    expect(app.settings.theme).toBeUndefined()
    expect(app.transcript.entries).toEqual([])
    expect(app.subagents.all).toEqual([])
    expect(app.sessions.current).toBeUndefined()
    expect(app.conversation.busy).toBe(false)
    expect(app.createPermissionPolicy()).toBeDefined()
    await app.shutdown()
  })

  it("shutdown finishes while a permission prompt is unanswered", async () => {
    const home = await isolate("otis-app-quit-")
    const app = await Application.create({
      cwd: home,
      env: { FIREWORKS_API_KEY: "fw_test" },
    })
    app.models.client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    app.models.selectedProvider = "fireworks"

    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        await options.agent.onPermissionRequest?.({
          call: { name: "bash", input: { command: "ls" } },
          decision: { effect: "ask", resources: [] },
        })
        return { status: "interrupted", messages: [], details: {} }
      },
    )

    const started = app.conversation.start({ role: "user", content: "run ls" })
    await vi.waitFor(() => expect(app.conversation.busy).toBe(true))
    await app.shutdown()
    expect(app.conversation.busy).toBe(false)
    await expect(started).resolves.toMatchObject({ status: "interrupted" })
  })
})

describe("Application prompt admission", () => {
  it("starts, steers into the running turn, and queues behind it, draining in order", async () => {
    const app = await ready()
    const first = gate()
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls += 1
        // Close the steering inbox so the follow-up is queued instead of steered.
        await options.agent.steering?.drainOrClose()
        if (calls === 1) await first.promise
        return turnEvents(`reply ${calls}`)(options)
      },
    )
    const { conversation } = app
    expect(await conversation.submit({ role: "user", content: "first" })).toEqual({
      delivery: "started",
    })
    expect(conversation.busy).toBe(true)
    expect(await conversation.submit({ role: "user", content: "second" })).toEqual({
      delivery: "queued",
    })
    expect(calls).toBe(1)

    first.resolve()
    await conversation.idle()
    expect(calls).toBe(2)
    const userEntries = app.transcript.entries.filter((entry) => entry.speaker === "You")
    expect(userEntries.map((entry) => entry.text)).toEqual(["first", "second"])
    expect(userEntries.every((entry) => entry.delivery === undefined)).toBe(true)
    expect(app.status()).toMatchObject({ busy: false, phase: "idle" })
    await app.shutdown()
  })

  it("rejects a prompt whose admission fails and records nothing for it", async () => {
    const app = await ready()
    vi.spyOn(app.sessions, "ensure").mockRejectedValue(new Error("disk full"))
    mocks.executeTurn.mockImplementation(turnEvents("unreachable"))

    await expect(app.conversation.submit({ role: "user", content: "hello" })).rejects.toThrow(
      "The prompt could not be submitted.",
    )
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    expect(app.transcript.entries.some((entry) => entry.speaker === "You")).toBe(false)
    expect(app.transcript.entries.some((entry) => entry.text.includes("disk full"))).toBe(true)
    await app.shutdown()
  })

  it("drains a follow-up whose admission finished after its predecessor completed", async () => {
    const app = await ready()
    const finishFirst = gate()
    const permitAdmission = gate()
    const admissionStarted = gate()
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls++
        await options.agent.steering?.drainOrClose()
        if (calls === 1) await finishFirst.promise
        return turnEvents("done")(options)
      },
    )
    await app.conversation.submit({ role: "user", content: "first" })
    const ensure = app.sessions.ensure.bind(app.sessions)
    vi.spyOn(app.sessions, "ensure").mockImplementation(async () => {
      admissionStarted.resolve()
      await permitAdmission.promise
      return ensure()
    })
    const followup = app.conversation.submit({ role: "user", content: "second" })
    await admissionStarted.promise
    finishFirst.resolve()
    await app.conversation.idle()
    permitAdmission.resolve()
    expect(await followup).toEqual({ delivery: "queued" })
    await vi.waitFor(() => expect(calls).toBe(2))
    await app.shutdown()
  })

  it("tells the caller why a prompt cannot run instead of dropping it", async () => {
    const app = await ready()
    const { models, conversation } = app
    models.client = undefined
    models.setState("starting")
    await expect(conversation.submit({ role: "user", content: "x" })).rejects.toThrow(
      "The model is still starting. Try again in a moment.",
    )
    models.setState("failed", "server did not start")
    await expect(conversation.submit({ role: "user", content: "x" })).rejects.toThrow(
      "server did not start",
    )
    models.setState("unconfigured")
    await expect(conversation.submit({ role: "user", content: "x" })).rejects.toThrow(
      "No model is configured. Set up inference with the Otis CLI first.",
    )
    models.client = fakeClient
    let release!: () => void
    const selecting = models.enqueueSelection(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await expect(conversation.submit({ role: "user", content: "x" })).rejects.toThrow(
      "A model switch is in progress. Try again in a moment.",
    )
    app.extraGate = () => "The window is busy."
    expect(app.admissionGate()).toBe("The window is busy.")
    app.extraGate = undefined
    await vi.waitFor(() => expect(release).toBeDefined())
    release()
    await selecting
    expect(app.admissionGate()).toBeUndefined()
    expect(app.transcript.entries).toHaveLength(0)
    await app.shutdown()
  })

  it("keeps queued work parked while no model can serve it and resumes once one settles", async () => {
    const app = await ready()
    mocks.executeTurn.mockImplementation(turnEvents("ran"))
    app.models.client = undefined
    app.models.setState("failed", "model failed to load")
    // Admitted to the session, waiting for a driver: never lost, never run into the void.
    await app.conversation.queue({ role: "user", content: "hold this" })
    app.conversation.drain()
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    expect(app.conversation.peekQueued()).toBeTruthy()

    // A selection settling with a client re-drives the backlog.
    app.models.client = fakeClient
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalledOnce())
    expect(JSON.stringify(mocks.executeTurn.mock.calls[0]?.[0])).toContain("hold this")
    await app.conversation.idle()
    expect(app.conversation.peekQueued()).toBeUndefined()
    await app.shutdown()
  })

  it("brokers permission requests, ignores stale replies, and denies them on stop", async () => {
    const app = await ready()
    const ask = (command: string): PermissionRequest => ({
      call: { name: "bash", input: { command } },
      decision: { effect: "ask", resources: [command] },
    })
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const allowed = await options.agent.onPermissionRequest?.(ask("bun test"))
        return turnEvents(allowed ? "allowed" : "denied")(options)
      },
    )
    const requests: unknown[] = []
    app.subscribe((event) => {
      if (event.type === "permission") requests.push(event.request)
    })
    await app.conversation.submit({ role: "user", content: "run the tests" })
    await vi.waitFor(() => expect(app.permissions.current).not.toBeNull())
    expect(app.status().permission).toMatchObject({
      label: "Running command: bun test",
      kind: "shell",
      resources: ["bun test"],
    })
    const pending = app.permissions.current
    if (!pending) throw new Error("expected a pending permission request")
    app.permissions.respond(999_999, true)
    expect(app.permissions.current).toBe(pending)
    app.permissions.respond(pending.id, false)
    await app.conversation.idle()
    expect(app.permissions.current).toBeNull()
    expect(app.transcript.entries.some((entry) => entry.text === "denied")).toBe(true)
    expect(requests).toEqual([pending, null])

    // An unanswered request is denied by Stop, and the approval card clears with it.
    let observed: boolean | undefined
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        observed = await options.agent.onPermissionRequest?.(ask("rm -rf build"))
        return { status: "interrupted", messages: [], details: {} }
      },
    )
    await app.conversation.submit({ role: "user", content: "clean the build" })
    await vi.waitFor(() => expect(app.permissions.current).not.toBeNull())
    app.conversation.stop()
    await app.conversation.idle()
    expect(observed).toBe(false)
    expect(app.permissions.current).toBeNull()
    await app.shutdown()
  })
})

describe("Application permissions", () => {
  const ask = (command: string): PermissionRequest => ({
    call: { name: "bash", input: { command } },
    decision: { effect: "ask", resources: [command] },
  })

  it("shows the broker head with its session, counts the rest, and denies all on shutdown", async () => {
    const app = await ready()
    let allowed: boolean | undefined
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        allowed = await options.agent.onPermissionRequest?.(ask("bun test"))
        return { status: "interrupted", messages: [], details: {} }
      },
    )
    const heads: unknown[] = []
    app.subscribe((event) => {
      if (event.type === "permission") heads.push(event.request)
    })
    await app.conversation.submit({ role: "user", content: "run the tests" })
    await vi.waitFor(() => expect(app.status().permission).not.toBeNull())
    expect(app.status()).toMatchObject({
      permission: {
        label: "Running command: bun test",
        runtime: app.conversation.id,
        sessionTitle: app.sessions.activeLabel(),
      },
      permissionQueue: 0,
    })

    // Another runtime's request queues behind the head: counted, not shown, and not this
    // conversation's.
    const other = app.permissions.request(
      { runtime: 999, title: () => "Other" },
      ask("ls"),
      new AbortController().signal,
    )
    expect(app.status()).toMatchObject({
      permission: { runtime: app.conversation.id },
      permissionQueue: 1,
    })
    expect(app.permissions.pending.map((request) => request.runtime)).toEqual([
      app.conversation.id,
      999,
    ])
    expect(heads).toEqual([app.permissions.current])

    // Stopping the conversation denies its own request only; the other one becomes the head.
    app.conversation.stop()
    await app.conversation.idle()
    expect(allowed).toBe(false)
    expect(app.status()).toMatchObject({
      permission: { runtime: 999, sessionTitle: "Other", label: "Inspecting files: ls" },
      permissionQueue: 0,
    })
    expect(heads).toHaveLength(2)

    await app.shutdown()
    await expect(other).resolves.toBe(false)
    expect(app.status()).toMatchObject({ permission: null, permissionQueue: 0 })
    expect(heads.at(-1)).toBeNull()
  })
})

describe("Application status", () => {
  const kimi = {
    provider: "fireworks" as const,
    id: "accounts/fireworks/models/kimi",
    displayName: "Kimi",
    contextLength: 128_000,
    supportsImageInput: true,
    fastId: "accounts/fireworks/routers/kimi-fast",
  }

  it("reports the saved hosted selection as ready with its display metadata", async () => {
    const home = await isolate("otis-app-status-")
    await saveSelectedModel(kimi)
    const app = await Application.create({ cwd: home, env: { FIREWORKS_API_KEY: "fw_test" } })
    const status = app.status()
    expect(status).toMatchObject({
      busy: false,
      phase: "idle",
      model: { id: kimi.id, provider: "fireworks", displayName: "Kimi", supportsImageInput: true },
      modelState: "ready",
      modelError: undefined,
      modelLoad: null,
      session: null,
      diffs: { added: 0, removed: 0 },
      contextLimit: app.models.autoCompactAtTokens,
      permission: null,
      permissionQueue: 0,
      localThinking: null,
      permissionMode: "auto",
      fastServing: { available: true, enabled: false },
      hostedConfigured: true,
      pairEndpoints: {},
      omlx: null,
      subagents: [],
    })
    expect(status.contextTokens).toBe(app.contextTokens())

    // Losing the client exposes the explicit state; a live client always reads as ready.
    app.models.client = undefined
    app.models.setState("failed", "server went away")
    expect(app.status()).toMatchObject({ modelState: "failed", modelError: "server went away" })
    app.models.client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    expect(app.status()).toMatchObject({ modelState: "ready", modelError: undefined })
    await app.shutdown()
  })

  it("starts a saved local model as starting and reports a failed or cancelled start", async () => {
    const home = await isolate("otis-app-start-")
    await saveSelectedModel({
      provider: "local",
      id: "Qwen/Qwen3.8-27B",
      displayName: "Qwen3.8 27B",
      contextLength: 32_768,
      supportsImageInput: false,
    })
    const app = await Application.create({ cwd: home, env: {} })
    expect(app.status()).toMatchObject({ modelState: "starting", model: { provider: "local" } })

    vi.spyOn(app.models, "prepare").mockRejectedValueOnce(new Error("no space left"))
    await expect(app.startSavedSelection()).rejects.toThrow("no space left")
    expect(app.status()).toMatchObject({ modelState: "failed", modelError: "no space left" })

    // A cancelled start is not a failure of the model, but nothing can serve prompts either.
    app.models.setState("starting")
    await app.cancelModelSelection()
    expect(app.status()).toMatchObject({
      modelState: "failed",
      modelError: "The model start was cancelled.",
    })

    const unconfigured = await Application.create({ cwd: home, env: {} })
    unconfigured.models.selectedId = undefined
    unconfigured.models.selectedProvider = undefined
    expect(await unconfigured.startSavedSelection()).toBe("unconfigured")
    expect(unconfigured.status().modelState).toBe("unconfigured")
    await app.shutdown()
    await unconfigured.shutdown()
  })

  it("fans model, session, and transcript changes into one subscription", async () => {
    const home = await isolate("otis-app-events-")
    const app = await Application.create({ cwd: home, env: {} })
    const events: AppEvent["type"][] = []
    const unsubscribe = app.subscribe((event) => events.push(event.type))

    app.models.setLoad({ modelId: "x", status: { label: "Loading", kind: "progress" } })
    app.sessions.addDiff(2, 1)
    app.transcript.addAssistantMessage("note")
    expect(events).toEqual(["status", "status", "transcript"])
    expect(app.status()).toMatchObject({
      modelLoad: { modelId: "x", status: { label: "Loading", kind: "progress" } },
      diffs: { added: 2, removed: 1 },
    })

    unsubscribe()
    app.models.setLoad(undefined)
    expect(events).toHaveLength(3)
    await app.shutdown()
  })
})

describe("Application model transactions", () => {
  beforeEach(() => {
    mocks.listDownloaded.mockReset().mockResolvedValue([])
    mocks.deleteGguf.mockReset().mockResolvedValue(undefined)
  })

  it("lets a model picked during the saved model's startup supersede it, never the reverse", async () => {
    const home = await isolate("otis-app-boot-")
    await saveSelectedModel(savedLocal)
    const app = await Application.create({ cwd: home, env: { FIREWORKS_API_KEY: "fw" } })
    // The saved model's startup is slow like a long download; a real prepare rejects when
    // aborted. If nothing aborts it, it commits late, over any selection made in the meantime.
    const prepare = preparing(app, async (signal) => {
      if (app.models.selectedProvider !== "local") return
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
    })
    const booting = app.startSavedSelection()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(app.status().modelState).toBe("starting")

    expect(await app.selectModel(kimiChoice)).toEqual({ ok: true })
    expect(await booting).toBe("superseded")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(app.models.selectedId).toBe(kimiChoice.id)
    expect(app.status()).toMatchObject({ modelState: "ready", modelLoad: null })
    expect((await loadLocalSettings()).model).toBe(kimiChoice.id)
    await app.shutdown()
  })

  it("selects a picker row: shortcuts an active live row, refuses unavailable ones, keeps failures on the row", async () => {
    const app = await ready("otis-app-select-")
    const prepare = preparing(app)
    expect(
      await app.selectModel({ ...kimiChoice, id: app.models.selectedId ?? "", active: true }),
    ).toEqual({ ok: true })
    expect(prepare).not.toHaveBeenCalled()
    expect(
      await app.selectModel({ ...localChoice, available: false, availabilityLabel: "Needs 48 GB" }),
    ).toEqual({ ok: false, reason: "Needs 48 GB" })

    prepare.mockRejectedValueOnce(new Error("server did not start"))
    expect(await app.selectModel(localChoice)).toEqual({
      ok: false,
      reason: "server did not start",
    })
    // A restored previous model stays ready; the failure stays on the row.
    expect(app.status()).toMatchObject({
      modelState: "ready",
      modelLoad: { modelId: localChoice.id, status: { label: "Failed: server did not start" } },
    })

    expect(await app.selectModel(localChoice)).toEqual({ ok: true })
    expect(app.models.selectedId).toBe(localChoice.id)
    expect((await loadLocalSettings()).modelProvider).toBe("local")
    await app.shutdown()
  })

  it("reports a failed first selection as a failed host and a PAIR failure on its engine row", async () => {
    const app = await Application.create({ cwd: await isolate("otis-app-first-"), env: {} })
    vi.spyOn(app.models, "prepare").mockRejectedValue(new Error("out of memory"))
    expect(await app.selectModel(localChoice)).toEqual({ ok: false, reason: "out of memory" })
    expect(app.status()).toMatchObject({ modelState: "failed", modelError: "out of memory" })
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
    expect(await app.selectModel(pairItem)).toEqual({ ok: false, reason: "out of memory" })
    expect(app.status().modelLoad?.modelId).toBe("pair:ollama:qwen3:32b")
    await app.shutdown()
  })

  it("refuses a switch during a turn and parks a follow-up until the switch settles", async () => {
    const app = await ready("otis-app-switch-")
    const first = gate()
    let calls = 0
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        calls += 1
        await options.agent.steering?.drainOrClose()
        if (calls === 1) await first.promise
        return turnEvents("ran")(options)
      },
    )
    await app.conversation.submit({ role: "user", content: "hold" })
    expect(await app.selectModel(localChoice)).toEqual({
      ok: false,
      reason: "Finish the current work before switching models.",
    })
    first.resolve()
    await app.conversation.idle()

    let release!: () => void
    preparing(app, () => new Promise<void>((resolve) => (release = resolve)))
    const switching = app.selectModel(localChoice)
    await vi.waitFor(() => expect(release).toBeDefined())
    await expect(app.conversation.submit({ role: "user", content: "during" })).rejects.toThrow(
      "A model switch is in progress.",
    )
    await app.conversation.queue({ role: "user", content: "parked" })
    app.conversation.drain()
    expect(calls).toBe(1)
    release()
    expect(await switching).toEqual({ ok: true })
    await vi.waitFor(() => expect(calls).toBe(2))
    await app.shutdown()
  })

  it("validates a Fireworks key against the catalog before saving and activating it", async () => {
    const home = await isolate("otis-app-key-")
    await saveSelectedModel({ ...kimiChoice, kind: undefined } as never)
    const app = await Application.create({ cwd: home, env: {} })
    expect(app.status().modelState).toBe("unconfigured")
    await expect(app.setFireworksApiKey("  ")).rejects.toThrow("Fireworks API key is required.")
    await expect(app.setFireworksApiKey("bad", { list: async () => [] })).rejects.toThrow(
      "no public models with tool support",
    )
    await expect(
      app.setFireworksApiKey("bad", {
        list: async () => {
          throw new Error("HTTP 401")
        },
      }),
    ).rejects.toThrow("HTTP 401")
    expect((await loadLocalSettings()).fireworksApiKey).toBeUndefined()

    const catalog = [{ ...kimiChoice, fastId: "accounts/fireworks/routers/kimi-fast" }]
    expect(await app.setFireworksApiKey(" good ", { list: async () => catalog as never })).toBe(
      catalog,
    )
    expect(app.fireworksApiKey).toBe("good")
    expect((await loadLocalSettings()).fireworksApiKey).toBe("good")
    expect(app.status()).toMatchObject({ modelState: "ready", hostedConfigured: true })
    expect(app.models.client?.model).toBe(kimiChoice.id)
    await app.shutdown()
  })

  it("deletes the active local model, clears the selection, and restores it when removal fails", async () => {
    const home = await isolate("otis-app-delete-")
    const spec = findLocalModel("openai/gpt-oss-20b")
    await saveSelectedModel({ ...savedLocal, id: "openai/gpt-oss-20b", displayName: "gpt-oss 20B" })
    const app = await Application.create({ cwd: home, env: {} })
    app.models.client = fakeClient
    app.models.selectedId = "openai/gpt-oss-20b"
    app.models.selectedProvider = "local"
    app.models.activeLocal = { spec, contextLength: 32_768 } as never
    const stop = vi.spyOn(app.models.llama, "stop").mockResolvedValue(undefined)
    const restore = vi.spyOn(app.models, "restorePrevious").mockResolvedValue(undefined)
    mocks.listDownloaded.mockResolvedValue([spec])

    mocks.deleteGguf.mockRejectedValueOnce(new Error("disk busy"))
    await expect(app.deleteLocalModel("openai/gpt-oss-20b")).rejects.toThrow(
      "Could not delete gpt-oss 20B: disk busy",
    )
    expect((await loadLocalSettings()).model).toBe("openai/gpt-oss-20b")
    expect(restore).toHaveBeenCalled()
    expect(app.models.selectedId).toBe("openai/gpt-oss-20b")

    mocks.listDownloaded.mockResolvedValueOnce([spec]).mockResolvedValueOnce([])
    expect(await app.deleteLocalModel("openai/gpt-oss-20b")).toEqual({
      wasActive: true,
      remaining: [],
    })
    expect(stop).toHaveBeenCalled()
    expect(app.models.client).toBeUndefined()
    expect(app.status()).toMatchObject({ model: null, modelState: "unconfigured" })
    expect((await loadLocalSettings()).model).toBeUndefined()
    await expect(app.deleteLocalModel("nope/nope")).rejects.toThrow("not in the local catalog")
    await app.shutdown()
  })

  it("refuses to delete while a selection is open, and shutdown waits for a deletion", async () => {
    const app = await ready("otis-app-delete-busy-")
    mocks.listDownloaded.mockResolvedValue([findLocalModel("openai/gpt-oss-20b")])
    let release!: () => void
    preparing(app, () => new Promise<void>((resolve) => (release = resolve)))
    const selecting = app.selectModel(localChoice)
    await vi.waitFor(() => expect(release).toBeDefined())
    await expect(app.deleteLocalModel("openai/gpt-oss-20b")).rejects.toThrow(
      "Finish the current work before deleting a model.",
    )
    release()
    expect(await selecting).toEqual({ ok: true })

    let finishDelete!: () => void
    mocks.deleteGguf.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve
        }),
    )
    const deleting = app.deleteLocalModel("openai/gpt-oss-20b")
    await vi.waitFor(() => expect(finishDelete).toBeDefined())
    // Prompts are refused for the deletion's span, like any other model transaction.
    await expect(app.conversation.submit({ role: "user", content: "x" })).rejects.toThrow(
      "A model switch is in progress.",
    )
    let shutDown = false
    const shutdown = app.shutdown().then(() => {
      shutDown = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shutDown).toBe(false)
    finishDelete()
    await deleting
    await shutdown
    expect(shutDown).toBe(true)
  })
})

describe("Application prompts with attachments", () => {
  beforeEach(() => {
    mocks.listToolCapableModels.mockReset()
  })

  const png = {
    type: "image" as const,
    name: "screen.png",
    mimeType: "image/png" as const,
    data: "iVBORw0KGgo=",
    sizeBytes: 8,
  }

  it("resolves an unknown image capability from the catalog once and persists the serving entry", async () => {
    const home = await isolate("otis-app-vision-")
    // A saved selection from before image support was recorded.
    await saveSelectedModel({
      ...kimiChoice,
      kind: undefined,
      supportsImageInput: undefined,
    } as never)
    const app = await Application.create({ cwd: home, env: { FIREWORKS_API_KEY: "fw" } })
    expect(app.models.supportsImageInput).toBeUndefined()
    mocks.listToolCapableModels.mockResolvedValue([
      { ...kimiChoice, kind: undefined, supportsImageInput: true, contextLength: 128_000 },
    ])

    const [first, second] = await Promise.all([
      app.buildPrompt("what is this", [png]),
      app.buildPrompt("and this", [png]),
    ])
    expect(first).toEqual({
      role: "user",
      content: [png, { type: "text", text: "what is this" }],
    })
    expect(second.role).toBe("user")
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()
    expect(app.models.supportsImageInput).toBe(true)
    expect(await loadLocalSettings()).toMatchObject({
      modelSupportsImageInput: true,
      modelContextLength: 128_000,
    })
    // Known from here on: no further lookups, text prompts never look.
    await app.buildPrompt("again", [png])
    await app.buildPrompt("plain", [])
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()
    await app.shutdown()
  })

  it("refuses images for a model without vision, by catalog spec for local models", async () => {
    const app = await ready("otis-app-novision-")
    app.models.supportsImageInput = undefined
    app.fireworksApiKey = undefined
    await expect(app.buildPrompt("see", [png])).rejects.toThrow(
      "accounts/fireworks/models/fake does not support image input. Choose a vision model.",
    )
    expect(mocks.listToolCapableModels).not.toHaveBeenCalled()

    app.models.selectedId = "openai/gpt-oss-20b"
    app.models.selectedProvider = "local"
    app.models.displayName = "gpt-oss 20B"
    app.models.supportsImageInput = undefined
    await expect(app.buildPrompt("see", [png])).rejects.toThrow(
      "gpt-oss 20B does not support image input. Choose a vision model.",
    )
    expect(app.models.supportsImageInput).toBe(false)
    expect(await app.buildPrompt("plain text", [])).toEqual({ role: "user", content: "plain text" })
    // Images already in the conversation count too, even for a text-only prompt.
    app.transcript.loadMessages([{ role: "user", content: [png] }])
    await expect(app.buildPrompt("continue", [])).rejects.toThrow("does not support image input")
    await app.shutdown()
  })
})

describe("Application session runtimes", () => {
  /** A turn that waits for `hold`, or ends interrupted when its signal aborts first. */
  function holding(hold: ReturnType<typeof gate>, text = "reply") {
    return async (options: TurnRunnerOptions): Promise<TurnResult> => {
      await options.agent.steering?.drainOrClose()
      const { signal } = options.agent
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true })
        void hold.promise.then(resolve)
      })
      if (signal?.aborted) return { status: "interrupted", messages: [], details: {} }
      return turnEvents(text)(options)
    }
  }

  async function stored(cwd: string, question: string, answer: string) {
    const session = await createSession({ cwd })
    const admission = await session.admitPrompt(question)
    await session.completeTurn(admission, [
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ])
    return session
  }

  it("opens a second session while the first works: it keeps running, unfocused, then reads as done", async () => {
    const app = await ready("otis-app-runtimes-")
    const first = app.focused
    const hold = gate()
    mocks.executeTurn.mockImplementation(holding(hold, "first reply"))
    await app.conversation.submit({ role: "user", content: "long task" })
    const saved = await stored(app.cwd, "stored question", "stored answer")
    const events: AppEvent[] = []
    app.subscribe((event) => events.push(event))

    expect(await app.openSession(saved.id)).toBe("opened")
    const second = app.focused
    expect(second).not.toBe(first)
    expect(app.runtimes).toEqual([first, second])
    expect([app.transcript, app.sessions, app.conversation, app.artifacts, app.subagents]).toEqual([
      second.transcript,
      second.sessions,
      second.conversation,
      second.artifacts,
      second.subagents,
    ])
    expect(app.transcript.entries.map((entry) => entry.text)).toEqual([
      "stored question",
      "stored answer",
    ])
    expect(events).toContainEqual({
      type: "transcript",
      change: { op: "reset" },
      runtime: second.id,
    })
    expect(app.status()).toMatchObject({
      busy: false,
      working: 1,
      session: { id: saved.id },
      runtimes: [
        { runtime: first.id, focused: false, busy: true, unseen: false },
        { runtime: second.id, focused: true, busy: false, session: { id: saved.id } },
      ],
    })
    expect(app.anyBusy).toBe(true)
    expect(app.openSessions()).toMatchObject([
      { id: first.sessions.current?.id, focused: false, working: true },
      { id: saved.id, focused: true, working: false, unseen: false },
    ])
    expect(await app.openSession(saved.id)).toBe("focused")
    expect(app.runtimes).toHaveLength(2)

    // Nothing that would cut the working runtime off is allowed.
    expect(await app.closeRuntime(first)).toBe("working")
    expect(await app.compact(undefined, first)).toBe(SESSION_REASONS.working)
    expect(await app.deleteSession(first.sessions.current?.id ?? "")).toBe("working")
    expect(await app.selectModel(localChoice)).toEqual({
      ok: false,
      reason: "Finish the current work before switching models.",
    })

    events.length = 0
    hold.resolve()
    await first.conversation.idle()
    expect(events.find((event) => event.type === "settled")?.runtime).toBe(first.id)
    expect(events.filter((event) => event.type === "transcript")).not.toHaveLength(0)
    expect(events.every((event) => event.runtime === first.id)).toBe(true)
    expect(first.transcript.entries.some((entry) => entry.text === "first reply")).toBe(true)
    expect(app.transcript.entries.some((entry) => entry.text === "first reply")).toBe(false)
    expect(first.unseen).toBe(true)
    expect(app.status()).toMatchObject({
      working: 0,
      runtimes: [{ unseen: true, busy: false }, { unseen: false }],
    })

    app.focus(first)
    expect(first.unseen).toBe(false)
    expect(app.transcript).toBe(first.transcript)
    expect(events.at(-1)).toEqual({ type: "status", runtime: first.id })
    expect(await app.closeRuntime(second)).toBe("closed")
    expect(app.runtimes).toEqual([first])
    expect(app.focused).toBe(first)
    await app.shutdown()
  })

  it("refuses a session another Otis holds, opens in place when idle, and deletes an idle open one by closing it", async () => {
    const app = await ready("otis-app-locked-")
    const other = await Application.create({ cwd: app.cwd, env: {} })
    const held = await other.sessions.ensure()
    expect(await app.openSession(held.id)).toBe("locked")
    expect(app.runtimes).toHaveLength(1)
    await other.shutdown()

    // An idle focused runtime takes the session in place, as a single-session switch always did.
    expect(await app.openSession(held.id)).toBe("opened")
    expect(app.runtimes).toHaveLength(1)
    expect(app.sessions.current?.id).toBe(held.id)

    // Starting fresh while that session works leaves it open beside the new focus.
    const hold = gate()
    mocks.executeTurn.mockImplementation(holding(hold))
    await app.conversation.submit({ role: "user", content: "work" })
    const working = app.focused
    const fresh = app.openNew()
    expect(fresh).not.toBe(working)
    expect(app.focused).toBe(fresh)
    expect(app.sessions.current).toBeUndefined()
    expect(await app.deleteSession(held.id)).toBe("working")

    hold.resolve()
    await working.conversation.idle()
    expect(await app.deleteSession(held.id)).toBe("deleted")
    expect(app.runtimes).toEqual([fresh])
    expect((await listSessions({ cwd: app.cwd })).map((session) => session.id)).not.toContain(
      held.id,
    )
    const lock = await acquireSessionLock({ cwd: app.cwd, sessionId: held.id })
    await lock.release()

    // Closing the last runtime leaves a fresh empty one.
    expect(await app.closeRuntime(fresh)).toBe("closed")
    expect(app.runtimes).toHaveLength(1)
    expect(app.focused).not.toBe(fresh)
    expect(app.sessions.current).toBeUndefined()
    await app.shutdown()
  })

  it("shutdown stops every runtime and releases every lock", async () => {
    const app = await ready("otis-app-shutdown-all-")
    const hold = gate()
    mocks.executeTurn.mockImplementation(holding(hold))
    await app.conversation.submit({ role: "user", content: "first" })
    const first = app.focused
    const second = app.openNew()
    await app.conversation.submit({ role: "user", content: "second" })
    expect(app.focused).toBe(second)
    expect(app.status()).toMatchObject({ busy: true, working: 1 })
    const ids = [first, second].map((runtime) => runtime.sessions.current?.id ?? "")
    expect(ids.every(Boolean)).toBe(true)

    await app.shutdown()
    expect(first.busy).toBe(false)
    expect(second.busy).toBe(false)
    for (const sessionId of ids) {
      const lock = await acquireSessionLock({ cwd: app.cwd, sessionId })
      await lock.release()
    }
  })
})

describe("workspace label", () => {
  it("abbreviates paths inside the home directory", () => {
    expect(formatWorkspaceLabel("/Users/test", "/Users/test")).toBe("~")
    expect(formatWorkspaceLabel("/Users/test/work/otis", "/Users/test")).toBe("~/work/otis")
  })

  it("compacts deep paths while preserving the current directory and its parent", () => {
    expect(formatWorkspaceLabel("/Users/test/code/clients/triangl/otis", "/Users/test")).toBe(
      "~/…/triangl/otis",
    )
    expect(formatWorkspaceLabel("/opt/company/projects/otis", "/Users/test")).toBe(
      "/…/projects/otis",
    )
  })

  it("does not treat a sibling path as part of the home directory", () => {
    expect(formatWorkspaceLabel("/Users/test-other/work/otis", "/Users/test")).toBe("/…/work/otis")
  })
})
