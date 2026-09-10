import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import type { TurnResult, TurnRunnerOptions } from "../../../src/app/turn-runner.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import type { InferenceClient } from "../../../src/inference/types.js"
import { useOtisHome } from "../../app/support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn(), listGlobal: vi.fn() }))
vi.mock("../../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
  return { ...original, isLocalGgufDownloaded: async () => false, listDownloadedLocalModels: async () => [] }
})
vi.mock("../../../src/app/global-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/app/global-sessions.js")>()
  return {
    ...original,
    listGlobalSessionPickerItems: (...args: unknown[]) => {
      mocks.listGlobal()
      return original.listGlobalSessionPickerItems(
        args[0] as Parameters<typeof original.listGlobalSessionPickerItems>[0],
      )
    },
  }
})

const isolate = useOtisHome()
const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }

describe("global session list caching", () => {
  it("refreshSessions surfaces sessions created externally (TUI) after launch", async () => {
    const home = await isolate("otis-cache-")
    const cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    const app = await Application.create({ cwd })
    const runtime = DesktopRuntime.forApplication(app, { cwd, version: "test", platform: "darwin", send: () => {} })

    await runtime.snapshot() // warms the cache
    const scansAfterWarm = mocks.listGlobal.mock.calls.length

    // A TUI instance creates a session in this workspace's store while the GUI keeps running.
    const { createSession } = await import("../../../src/storage/index.js")
    const external = await createSession({ cwd })
    await external.admitPrompt("from the terminal")

    expect((await runtime.snapshot()).sessions.some((s) => s.id === external.id)).toBe(false) // still cached
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
    app.models.client = fakeClient
    app.models.selectedId = "accounts/fireworks/models/fake"
    app.models.selectedProvider = "fireworks"
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
    })

    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      for (let i = 0; i < 5; i += 1) await options.onEvent?.({ type: "delta", text: `chunk ${i}` })
      await options.onEvent?.({
        type: "complete",
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      })
      return { status: "complete", messages: [], details: {} }
    })

    await runtime.sendPrompt("stream something")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text?.includes("chunk 4"))).toBe(true),
    )
    const scansDuringStreaming = mocks.listGlobal.mock.calls.length
    await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))

    // More status flushes after streaming must not rescan; the settled turn invalidated once, so allow one more.
    await runtime.snapshot()
    await runtime.snapshot()
    expect(mocks.listGlobal.mock.calls.length).toBeLessThanOrEqual(scansDuringStreaming + 1)

    // A session operation invalidates: the next status recomputes.
    runtime.startNewSession()
    await runtime.snapshot()
    expect(mocks.listGlobal.mock.calls.length).toBeGreaterThan(scansDuringStreaming)
    await runtime.shutdown()
  })
})
