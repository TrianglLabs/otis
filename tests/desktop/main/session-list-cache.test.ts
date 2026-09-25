import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import type { TurnResult, TurnRunnerOptions } from "../../../src/app/turn-runner.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import type { CatalogModel, InferenceClient } from "../../../src/inference/types.js"
import { useOtisHome } from "../../app/support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn(), listGlobal: vi.fn() }))
vi.mock("../../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
  return {
    ...original,
    isLocalGgufDownloaded: async () => false,
    listDownloadedLocalModels: async () => [],
  }
})
vi.mock("../../../src/app/global-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/app/global-sessions.js")>()
  return {
    ...original,
    listGlobalHistory: (...args: Parameters<typeof original.listGlobalHistory>) => {
      mocks.listGlobal()
      return original.listGlobalHistory(...args)
    },
  }
})

const isolate = useOtisHome()
const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
const fakeModel: CatalogModel = {
  provider: "fireworks",
  id: "accounts/fireworks/models/fake",
  displayName: "accounts/fireworks/models/fake",
  supportsImageInput: false,
}

describe("global session list caching", () => {
  it("coalesces concurrent snapshots into one history scan", async () => {
    const home = await isolate("otis-cache-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })
    const scansBefore = mocks.listGlobal.mock.calls.length

    await Promise.all(Array.from({ length: 10 }, () => runtime.snapshot()))

    expect(mocks.listGlobal.mock.calls.length).toBe(scansBefore + 1)
    await runtime.shutdown()
  })

  it("refreshSessions surfaces sessions created externally (TUI) after launch", async () => {
    const home = await isolate("otis-cache-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    await runtime.snapshot() // warms the cache
    const scansAfterWarm = mocks.listGlobal.mock.calls.length

    // A TUI instance creates a session in this workspace's store while the GUI keeps running.
    const { createSession } = await import("../../../src/storage/session.js")
    const external = await createSession({ cwd })
    await external.admitPrompt("from the terminal")

    // Still cached.
    expect((await runtime.snapshot()).sessions.some((s) => s.id === external.id)).toBe(false)
    runtime.refreshSessions()
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).sessions.some((s) => s.id === external.id)).toBe(true),
    )
    expect(mocks.listGlobal.mock.calls.length).toBeGreaterThan(scansAfterWarm)
    await runtime.shutdown()
  })

  it("does not rescan history on streaming status flushes; session operations invalidate", async () => {
    const home = await isolate("otis-cache-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    app.focused.selection = { model: fakeModel, supportsImageInput: false, client: fakeClient }
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    // The turn streams, then waits to be released, so "during streaming" is not a race.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        for (let i = 0; i < 5; i += 1)
          await options.onEvent?.({ type: "delta", text: `chunk ${i}` })
        await held
        await options.onEvent?.({
          type: "complete",
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        })
        return { status: "complete", messages: [], details: {} }
      },
    )

    await runtime.sendPrompt("stream something")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text?.includes("chunk 4"))).toBe(
        true,
      ),
    )
    // Status flushes while streaming reuse the one scan the prompt's admission caused.
    const scansDuringStreaming = mocks.listGlobal.mock.calls.length
    await runtime.snapshot()
    await runtime.snapshot()
    expect(mocks.listGlobal.mock.calls.length).toBe(scansDuringStreaming)

    // The settled turn invalidates once; flushes after that reuse it.
    release()
    await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
    const scansAfterTurn = mocks.listGlobal.mock.calls.length
    await runtime.snapshot()
    await runtime.snapshot()
    expect(mocks.listGlobal.mock.calls.length).toBe(scansAfterTurn)

    // A session operation invalidates: the next status recomputes.
    runtime.startNewSession()
    await runtime.snapshot()
    expect(mocks.listGlobal.mock.calls.length).toBeGreaterThan(scansAfterTurn)
    await runtime.shutdown()
  })
})
