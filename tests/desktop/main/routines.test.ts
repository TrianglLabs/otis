import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import type { TurnResult, TurnRunnerOptions } from "../../../src/app/turn-runner.js"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import type { CatalogModel, ChatMessage, InferenceClient } from "../../../src/inference/types.js"
import { useOtisHome } from "../../app/support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
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

async function setup() {
  const home = await isolate("otis-desktop-routines-")
  const cwd = join(home, "alpha")
  const other = join(home, "beta")
  await mkdir(cwd, { recursive: true })
  await mkdir(other, { recursive: true })
  const app = await Application.create({ cwd })
  app.focused.selection = { model: fakeModel, supportsImageInput: false, client: fakeClient }
  const sent: DesktopEvent[] = []
  const runtime = DesktopRuntime.forApplication(app, {
    cwd,
    version: "test",
    platform: "darwin",
    // Copied as the IPC boundary would: an event holds what was sent, not live objects.
    send: (event) => sent.push(structuredClone(event)),
    sendTerminal: () => {},
    spawnPty: () => {
      throw new Error("The tests run no shell.")
    },
  })
  return { app, runtime, other, sent }
}

/** The last run as the status events told the renderer; the window never sees a full snapshot. */
function toldLastRun(sent: DesktopEvent[]) {
  return sent.flatMap((event) =>
    event.type === "status" && event.status.routines ? [event.status.routines[0]?.lastRun] : [],
  )
}

const input = (cwd: string) => ({
  name: "Beta digest",
  prompt: "Summarize beta.",
  cwd,
  schedule: { kind: "interval" as const, minutes: 30 },
  auto: false,
  enabled: false,
})

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

describe("DesktopRuntime routines", () => {
  it("hosts runs: an off-screen run closes and opening it marks it seen", async () => {
    const { app, runtime, other, sent } = await setup()
    mocks.executeTurn.mockImplementation(reply("Beta done"))
    expect(
      await runtime.saveRoutine({ ...input(other), schedule: { kind: "daily", time: "25:00" } }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("HH:MM") })
    expect(await runtime.saveRoutine(input(other))).toEqual({ ok: true })
    const [saved] = (await runtime.snapshot()).routines
    expect(saved?.enabled).toBe(false)

    expect(await runtime.runRoutine(saved?.id ?? "")).toEqual({ ok: true })
    // The window learns of the finish from a status event, never a fresh snapshot: the run object
    // was already sent while running and changed in place since.
    await vi.waitFor(() => expect(toldLastRun(sent).at(-1)).toMatchObject({ status: "complete" }))
    // The run was never on screen: its runtime closes once the run is recorded, and nobody has
    // seen it yet.
    await vi.waitFor(() => expect(app.runtimes).toHaveLength(1))
    const run = toldLastRun(sent).at(-1)
    expect(run?.seen).toBeUndefined()
    expect(await runtime.selectSession(run?.sessionId ?? "", run?.dirName)).toEqual({ ok: true })
    // And of the seen mark, which clears the dots on the Routines tab and the card.
    await vi.waitFor(() => expect(toldLastRun(sent).at(-1)?.seen).toBe(true))
    expect((await runtime.snapshot()).routines[0]?.lastRun?.seen).toBe(true)
    expect(await runtime.runRoutine("nope")).toMatchObject({ ok: false })
    await runtime.shutdown()
  })

  it("keeps a watched run on screen, refuses a second start, and marks it seen when it ends", async () => {
    const { app, runtime, other } = await setup()
    let finish: (result: TurnResult) => void = () => {}
    mocks.executeTurn.mockImplementation(
      () => new Promise<TurnResult>((resolveTurn) => (finish = resolveTurn)),
    )
    await runtime.saveRoutine(input(other))
    const id = (await runtime.snapshot()).routines[0]?.id ?? ""
    expect(await runtime.runRoutine(id)).toEqual({ ok: true })
    await vi.waitFor(() => expect(mocks.executeTurn).toHaveBeenCalledOnce())
    expect(await runtime.runRoutine(id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already"),
    })

    // Watching it: the run's runtime takes the screen, and stays once the run ends.
    const running = (await runtime.snapshot()).routines[0]?.runtime
    runtime.focusSession(running ?? -1)
    finish({ status: "complete", messages: [], details: {} })
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).routines[0]?.lastRun?.seen).toBe(true),
    )
    expect(app.runtimes.map((entry) => entry.id)).toContain(running)
    expect(app.focused.id).toBe(running)
    await runtime.deleteRoutine(id)
    expect((await runtime.snapshot()).routines).toEqual([])
    await runtime.shutdown()
  })
})
