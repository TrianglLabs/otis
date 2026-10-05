import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  Application,
  type SelectionResult,
  type SessionRuntime,
} from "../../src/app/application.js"
import { Routines } from "../../src/app/routines.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { CatalogModel, ChatMessage, InferenceClient } from "../../src/inference/types.js"
import { loadRoutines, nextRunAt, type Routine, saveRoutines } from "../../src/local/routines.js"
import { listSessions } from "../../src/storage/session.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/inference/gguf-cache.js")>()
  return {
    ...original,
    isLocalGgufDownloaded: async () => false,
    listDownloadedLocalModels: async () => [],
  }
})

const isolate = useOtisHome()
const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
const fakeModel: CatalogModel = {
  provider: "fireworks",
  id: "accounts/fireworks/models/fake",
  displayName: "fake",
  supportsImageInput: false,
}

function reply(text: string) {
  return async (options: TurnRunnerOptions): Promise<TurnResult> => {
    const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text }] }]
    await options.onEvent?.({ type: "complete", messages })
    return { status: "complete", messages, details: {} }
  }
}

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  name: "Morning digest",
  prompt: "Summarize what changed.",
  cwd: "/tmp/x",
  schedule: { kind: "interval", minutes: 30 },
  auto: false,
  enabled: true,
  createdAt: "2026-10-05T08:00:00.000Z",
  ...over,
})

async function setup() {
  const home = await isolate("otis-routines-")
  const cwd = join(home, "alpha")
  const other = join(home, "beta")
  await mkdir(cwd, { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(join(other, "AGENTS.md"), "Beta rules")
  const app = await Application.create({ cwd, env: {} })
  app.focused.selection = { model: fakeModel, supportsImageInput: false, client: fakeClient }
  const file = join(home, "routines.json")
  return { app, cwd, other, file }
}

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

describe("routine schedules", () => {
  it("counts an interval from the last start, else from creation", () => {
    expect(nextRunAt(routine())?.toISOString()).toBe("2026-10-05T08:30:00.000Z")
    const ran = routine({
      lastRun: {
        startedAt: "2026-10-05T08:50:00.000Z",
        status: "complete",
        sessionId: "s",
        dirName: "d",
      },
    })
    expect(nextRunAt(ran)?.toISOString()).toBe("2026-10-05T09:20:00.000Z")
    expect(nextRunAt(routine({ enabled: false }))).toBeUndefined()
  })

  it("places a daily time after the last start, so a slot missed while closed is due at launch", () => {
    const created = new Date(2026, 9, 5, 8, 0)
    const daily = routine({
      schedule: { kind: "daily", time: "07:30" },
      createdAt: created.toISOString(),
    })
    // Created after today's slot: the first run is tomorrow's.
    const tomorrow = nextRunAt(daily)
    expect([tomorrow?.getDate(), tomorrow?.getHours(), tomorrow?.getMinutes()]).toEqual([6, 7, 30])
    // Ran yesterday morning; today's 07:30 passed while Otis was closed: due now.
    const missed = routine({
      schedule: { kind: "daily", time: "07:30" },
      createdAt: created.toISOString(),
      lastRun: {
        startedAt: new Date(2026, 9, 5, 7, 30).toISOString(),
        status: "complete",
        sessionId: "s",
        dirName: "d",
      },
    })
    const now = new Date(2026, 9, 6, 12, 0)
    const due = nextRunAt(missed)
    expect(due && due <= now).toBe(true)
    expect([due?.getDate(), due?.getHours()]).toEqual([6, 7])
  })
})

describe("routines file", () => {
  it("round-trips, treats a run left running as interrupted, and rejects a broken file", async () => {
    const home = await isolate("otis-routines-file-")
    const file = join(home, "routines.json")
    expect(await loadRoutines(file)).toEqual([])
    const saved = routine({
      lastRun: {
        startedAt: "2026-10-05T08:00:00.000Z",
        status: "running",
        sessionId: "s",
        dirName: "d",
      },
    })
    await saveRoutines([saved], file)
    expect(await loadRoutines(file)).toEqual([
      { ...saved, lastRun: { ...saved.lastRun, status: "interrupted" } },
    ])
    await writeFile(file, JSON.stringify({ version: 1, routines: [{ id: "x" }] }))
    await expect(loadRoutines(file)).rejects.toThrow("Invalid routine: name.")
    await writeFile(file, JSON.stringify({ version: 2 }))
    await expect(loadRoutines(file)).rejects.toThrow("expected version 1")
  })
})

describe("routine runs", () => {
  it("runs in the routine's folder as its own runtime, records the run, and hands the runtime back", async () => {
    const { app, other, file } = await setup()
    mocks.executeTurn.mockImplementation(reply("Digest ready"))
    const released: SessionRuntime[] = []
    const routines = new Routines(app, await loadRoutines(file), {
      file,
      now: () => new Date("2026-10-05T09:00:00.000Z"),
    })
    routines.attach({
      release: (runtime) => released.push(runtime),
      selectModel: async () => ({ ok: true }),
    })
    const saved = await routines.save({
      name: "Morning digest",
      prompt: "Summarize what changed.",
      cwd: other,
      schedule: { kind: "interval", minutes: 30 },
      auto: false,
      enabled: true,
    })
    expect(saved.id).toMatch(/^routine_/)
    // The app's own mode does not reach the run: a routine that may not ask gets dontAsk.
    app.permissionMode = "ask"

    const run = await routines.run(saved.id)
    expect(run).toMatchObject({ status: "complete", startedAt: "2026-10-05T09:00:00.000Z" })
    const [runtime] = released
    expect(runtime?.workspace.cwd).toBe(other)
    expect(runtime?.permissionMode).toBe("dontAsk")
    expect(runtime).not.toBe(app.focused)
    // The turn ran in beta with beta's instructions and the saved prompt.
    const call = mocks.executeTurn.mock.calls[0]?.[0] as TurnRunnerOptions
    expect(call.agent.cwd).toBe(other)
    expect(call.agent.projectContext?.map((file) => file.content)).toEqual(["Beta rules"])
    expect(call.input.content).toBe("Summarize what changed.")
    // The session lives in beta's store under the routine's name, and the file remembers the run.
    const [session] = await listSessions({ cwd: other })
    expect(session?.id).toBe(run?.sessionId)
    expect(session?.title.startsWith("Morning digest · ")).toBe(true)
    const stored = await loadRoutines(file)
    expect(stored[0]?.lastRun).toEqual(run)
    expect(routines.list()[0]).toMatchObject({
      runtime: undefined,
      nextRunAt: "2026-10-05T09:30:00.000Z",
    })
    await app.shutdown()
  })

  it("starts due routines on a tick, never twice at once, and can be cancelled", async () => {
    const { app, other, file } = await setup()
    let now = new Date("2026-10-05T09:00:00.000Z")
    let finish: (result: TurnResult) => void = () => {}
    mocks.executeTurn.mockImplementation(
      (options: TurnRunnerOptions) =>
        new Promise<TurnResult>((resolve) => {
          finish = resolve
          options.agent.signal?.addEventListener("abort", () =>
            resolve({ status: "interrupted", messages: [], details: {} }),
          )
        }),
    )
    const routines = new Routines(
      app,
      [
        routine({
          cwd: other,
          createdAt: "2026-10-05T08:00:00.000Z",
          schedule: { kind: "interval", minutes: 30 },
        }),
      ],
      { file, now: () => now },
    )
    routines.attach({
      release: (runtime) => app.closeRuntime(runtime),
      selectModel: async () => ({ ok: true }),
    })
    const changes: boolean[] = []
    routines.subscribe(() => changes.push(routines.list()[0]?.runtime !== undefined))
    const settled = () =>
      vi.waitFor(() => expect(routines.list()[0]?.lastRun?.finishedAt).toBeDefined())

    routines.tick()
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalledTimes(1))
    expect(routines.list()[0]?.runtime).toBe(app.runtimes[1]?.id)
    // A second tick while the run is on does not start another, and neither does a manual start.
    routines.tick()
    expect(() => routines.run("r1")).toThrow("already running")
    expect(mocks.executeTurn).toHaveBeenCalledTimes(1)

    // Editing while it runs keeps the routine's identity, so the run still lands on it.
    await routines.save({ ...routine({ cwd: other }), name: "Renamed digest" })
    await expect(routines.save({ ...routine({ cwd: other }), id: "ghost" })).rejects.toThrow(
      "no longer exists",
    )
    routines.cancel("r1")
    await settled()
    expect(routines.list()[0]?.name).toBe("Renamed digest")
    expect(routines.list()[0]).toMatchObject({
      runtime: undefined,
      lastRun: { status: "interrupted" },
    })
    await vi.waitFor(() => expect(app.runtimes).toHaveLength(1))
    expect(changes).toContain(true)

    // Done for this interval: nothing is due until 30 minutes after that start.
    routines.tick()
    expect(mocks.executeTurn).toHaveBeenCalledTimes(1)
    now = new Date("2026-10-05T09:31:00.000Z")
    routines.tick()
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalledTimes(2))
    finish({ status: "complete", messages: [], details: {} })
    await vi.waitFor(() => expect(routines.list()[0]?.lastRun?.status).toBe("complete"))

    await routines.remove("r1")
    expect(routines.list()).toEqual([])
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, routines: [] })
    await app.shutdown()
  })

  it("leaves a run due while no model can serve it, and records a turn that fails", async () => {
    const { app, other, file } = await setup()
    app.focused.selection = undefined
    const unhosted = new Routines(app, [routine({ cwd: other })], { file })
    expect(() => unhosted.run("r1")).toThrow("desktop app")
    const routines = new Routines(app, [routine({ cwd: other })], { file })
    const selectModel = vi.fn(async (runtime: SessionRuntime): Promise<SelectionResult> => {
      runtime.selection = { model: fakeModel, supportsImageInput: false, client: fakeClient }
      return { ok: true }
    })
    routines.attach({ release: (runtime) => app.closeRuntime(runtime), selectModel })
    expect(await routines.run("r1")).toBeUndefined()
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    expect(app.runtimes).toHaveLength(1)
    expect(routines.list()[0]?.runtime).toBeUndefined()
    expect(routines.list()[0]?.lastRun).toBeUndefined()
    expect(() => routines.run("nope")).toThrow("no longer exists")

    app.focused.selection = { model: fakeModel, supportsImageInput: false, client: fakeClient }
    mocks.executeTurn.mockRejectedValue(new Error("boom"))
    const run = await routines.run("r1")
    expect(run?.status).toBe("error")
    expect(run?.finishedAt).toBeDefined()
    // Opening the run's session marks it seen, and the file remembers that.
    expect(routines.list()[0]?.lastRun?.seen).toBeUndefined()
    await routines.seen(run?.sessionId as string)
    expect(routines.list()[0]?.lastRun?.seen).toBe(true)
    expect((await loadRoutines(file))[0]?.lastRun?.seen).toBe(true)
    // A routine's own model is selected before the gate: with no session model at all, the run
    // still goes ahead on it.
    app.focused.selection = undefined
    mocks.executeTurn.mockImplementation(reply("On its own model"))
    await routines.save({ ...routine(), cwd: other, model: "accounts/x/models/y" })
    expect((await routines.run("r1"))?.status).toBe("complete")
    expect(selectModel).toHaveBeenCalledExactlyOnceWith(expect.anything(), "accounts/x/models/y")
    // A model the host cannot provide fails the run before its turn, and says why.
    selectModel.mockResolvedValueOnce({
      ok: false,
      reason: "That model is no longer in the catalog.",
    })
    expect(await routines.run("r1")).toMatchObject({
      status: "error",
      error: "That model is no longer in the catalog.",
    })
    expect(mocks.executeTurn).toHaveBeenCalledTimes(2)
    expect((await loadRoutines(file))[0]?.lastRun?.status).toBe("error")
    // Removing a routine that is already gone is nothing to do.
    await routines.remove("r1")
    await routines.remove("r1")
    expect(routines.list()).toEqual([])
    expect(app.runtimes).toHaveLength(1)
    await app.shutdown()
  })
})
