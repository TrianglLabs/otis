import { describe, expect, it, vi } from "vitest"
import { findLocalModel } from "../../src/inference/local-catalog.js"
import { getMocks, loadCli, settle, submit, testSession } from "./support/interactive-cli-harness.js"

const mocks = getMocks()

describe("CLI renderer recovery", () => {
  it("forces a terminal repaint when focus returns", async () => {
    await loadCli()

    for (const handler of mocks.rendererHandlers.get("focus") ?? []) handler()

    expect(mocks.renderer.resetSplitFooterForReplay).toHaveBeenCalledWith({ clearSavedLines: false })
  })
})

describe("CLI update hint", () => {
  it("shows an update hint when a newer version is available", async () => {
    mocks.checkForUpdate.mockResolvedValue({ available: true, version: "0.2.0" })

    await loadCli()
    await settle()

    expect(mocks.ui.showUpdateHint).toHaveBeenCalled()
  })

  it("does not show an update hint when already up to date", async () => {
    mocks.checkForUpdate.mockResolvedValue({ available: false, version: "0.1.0" })

    await loadCli()
    await settle()

    expect(mocks.ui.showUpdateHint).not.toHaveBeenCalled()
  })

  it("does not crash when the update check fails", async () => {
    mocks.checkForUpdate.mockRejectedValue(new Error("network down"))

    await loadCli()
    await settle()

    expect(mocks.ui.showUpdateHint).not.toHaveBeenCalled()
  })

  it("dismisses the update hint on first input", async () => {
    mocks.checkForUpdate.mockResolvedValue({ available: true, version: "0.2.0" })

    await loadCli()
    await settle()

    mocks.ui.showUpdateHint.mockClear()
    mocks.ui.hideUpdateHint.mockClear()

    await submit("hello")

    expect(mocks.ui.hideUpdateHint).toHaveBeenCalled()
  })

  it("aborts the update check when the user exits", async () => {
    let capturedSignal: AbortSignal | undefined
    mocks.checkForUpdate.mockImplementation(async (options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal
      return new Promise(() => {})
    })

    await loadCli()
    await settle()

    expect(capturedSignal?.aborted).toBe(false)

    await submit("/exit")
    await settle()

    expect(capturedSignal?.aborted).toBe(true)
  })
})

describe("CLI shutdown", () => {
  it("disables OpenTUI's default Ctrl+C and signal exit so Otis can stop llama-server first", async () => {
    await loadCli()

    expect(mocks.createCliRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        exitOnCtrlC: false,
        exitSignals: [],
      }),
    )
  })

  it("waits for llama-server to stop before destroying the renderer on /exit", async () => {
    let release = () => {}
    mocks.stopLocalRuntime.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    try {
      await loadCli()
      const exiting = submit("/exit")
      await settle()

      expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
      expect(mocks.renderer.destroy).not.toHaveBeenCalled()

      release()
      await exiting

      expect(mocks.renderer.destroy).toHaveBeenCalledOnce()
      expect(mocks.stopLocalRuntime.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.renderer.destroy.mock.invocationCallOrder[0],
      )
    } finally {
      release()
    }
  })

  it("uses the same stop-then-destroy path for Ctrl+C", async () => {
    let release = () => {}
    mocks.stopLocalRuntime.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    try {
      await loadCli()
      const exiting = Promise.resolve(mocks.uiOptions?.onQuit?.())
      await settle()

      expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
      expect(mocks.renderer.destroy).not.toHaveBeenCalled()

      release()
      await exiting

      expect(mocks.renderer.destroy).toHaveBeenCalledOnce()
      expect(mocks.stopLocalRuntime.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.renderer.destroy.mock.invocationCallOrder[0],
      )
    } finally {
      release()
    }
  })

  it.each(["SIGINT", "SIGTERM"] as const)("uses the same stop-then-destroy path for %s", async (signal) => {
    let release = () => {}
    const once = vi.spyOn(process, "once")
    mocks.stopLocalRuntime.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    try {
      await loadCli()
      const handler = once.mock.calls.find(([event]) => event === signal)?.[1] as (() => void) | undefined
      expect(handler).toBeTypeOf("function")
      handler?.()
      await settle()

      expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
      expect(mocks.renderer.destroy).not.toHaveBeenCalled()

      release()
      await vi.waitFor(() => expect(mocks.renderer.destroy).toHaveBeenCalledOnce())
      expect(mocks.stopLocalRuntime.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.renderer.destroy.mock.invocationCallOrder[0],
      )
    } finally {
      release()
      once.mockRestore()
    }
  })

  it("stops llama-server only once when quit is requested twice", async () => {
    await loadCli()
    await mocks.uiOptions?.onQuit?.()
    await mocks.uiOptions?.onQuit?.()

    expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
    expect(mocks.renderer.destroy).toHaveBeenCalledOnce()
  })

  it("aborts model catalog discovery before destroying the renderer", async () => {
    let catalogSignal: AbortSignal | undefined
    mocks.listToolCapableModels.mockImplementation(
      (_apiKey, options) =>
        new Promise((_resolve, reject) => {
          catalogSignal = options?.signal
          catalogSignal?.addEventListener("abort", () => reject(catalogSignal?.reason), { once: true })
        }),
    )
    await loadCli()

    const opening = submit("/model")
    await vi.waitFor(() => expect(catalogSignal).toBeDefined())
    const quitting = Promise.resolve(mocks.uiOptions?.onQuit?.())

    await quitting
    await opening
    expect(catalogSignal?.aborted).toBe(true)
    expect(mocks.ui.showModelPicker).not.toHaveBeenCalled()
    expect(mocks.renderer.destroy).toHaveBeenCalledOnce()
  })

  it("waits for local model deletion before destroying the renderer", async () => {
    const cached = findLocalModel("openai/gpt-oss-20b")
    if (!cached) throw new Error("missing local model")
    let finishDelete = () => {}
    mocks.listDownloadedLocalModels.mockResolvedValue([cached])
    mocks.deleteLocalGguf.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finishDelete = () => {
            mocks.listDownloadedLocalModels.mockResolvedValue([])
            resolve(undefined)
          }
        }),
    )

    try {
      await loadCli()
      await submit(`/settings delete-model ${cached.id}`)
      await vi.waitFor(() => expect(mocks.deleteLocalGguf).toHaveBeenCalled())

      const quitting = Promise.resolve(mocks.uiOptions?.onQuit?.())
      await settle()
      expect(mocks.renderer.destroy).not.toHaveBeenCalled()

      finishDelete()
      await quitting
      expect(mocks.renderer.destroy).toHaveBeenCalledOnce()
    } finally {
      finishDelete()
    }
  })
})

describe("CLI agent status phases", () => {
  it("tracks the agent phase as reasoning, text, and tool events stream", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "model", phase: "start" }
      yield {
        type: "reasoning",
        phase: "start",
        reasoningId: "reasoning_1",
        field: "reasoning_content",
        startedAt: "2026-08-06T12:00:00.000Z",
      }
      yield { type: "reasoning", phase: "delta", reasoningId: "reasoning_1", text: "Inspect the file." }
      yield {
        type: "reasoning",
        phase: "end",
        reasoningId: "reasoning_1",
        endedAt: "2026-08-06T12:00:00.500Z",
        durationMs: 500,
      }
      yield { type: "delta", text: "Let me check that file." }
      yield {
        type: "tool",
        phase: "start",
        toolCallId: "call_1",
        name: "read",
        activityKind: "read",
        label: "Reading note.txt",
      }
      yield {
        type: "tool",
        phase: "end",
        toolCallId: "call_1",
        name: "read",
        activityKind: "read",
        label: "Reading note.txt",
      }
      yield { type: "model", phase: "start" }
      yield { type: "delta", text: "Done." }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })

    await loadCli()
    await submit("check the note")
    await settle()

    expect(mocks.ui.setAgentPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "working",
      "thinking",
      "working",
      "working",
      "working",
      "working",
    ])
    expect(mocks.ui.renderTranscript.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "reasoning",
          reasoningId: "reasoning_1",
          text: "Inspect the file.",
          durationMs: 500,
          streaming: false,
        }),
      ]),
    )
  })

  it("keeps the plain wave when the model never reasons", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "model", phase: "start" }
      yield { type: "delta", text: "done" }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })

    await loadCli()
    await submit("quick answer")
    await settle()

    expect(mocks.ui.setAgentPhase).toHaveBeenCalledWith("working")
    expect(mocks.ui.setAgentPhase).not.toHaveBeenCalledWith("thinking")
  })
})

describe("CLI completion notification", () => {
  it("rings the bell when a turn completes and the terminal is unfocused", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "done" }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()

    for (const handler of mocks.rendererHandlers.get("blur") ?? []) handler()

    await submit("do something")
    await settle()

    expect(writeSpy).toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })

  it("does not ring the bell when a turn completes and the terminal is focused", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "done" }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()
    await submit("do something")
    await settle()

    expect(writeSpy).not.toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })

  it("does not ring the bell when a turn is interrupted", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "partial" }
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()

    for (const handler of mocks.rendererHandlers.get("blur") ?? []) handler()

    await submit("do something")
    await settle()

    expect(writeSpy).not.toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })

  it("rings the bell on error when the terminal is unfocused", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "error", message: "provider down" }
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()

    for (const handler of mocks.rendererHandlers.get("blur") ?? []) handler()

    await submit("do something")
    await settle()

    expect(writeSpy).toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })

  it("does not ring the bell on error when the terminal is focused", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "error", message: "provider down" }
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()
    await submit("do something")
    await settle()

    expect(writeSpy).not.toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })

  it("stops ringing the bell after the terminal regains focus", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "first" }
        yield { type: "complete", messages: [{ role: "user", content: "first" }] }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "second" }
        yield { type: "complete", messages: [{ role: "user", content: "second" }] }
      })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await loadCli()

    for (const handler of mocks.rendererHandlers.get("blur") ?? []) handler()
    await submit("first")
    await settle()
    writeSpy.mockClear()

    for (const handler of mocks.rendererHandlers.get("focus") ?? []) handler()
    await submit("second")
    await settle()

    expect(writeSpy).not.toHaveBeenCalledWith("\x07")
    writeSpy.mockRestore()
  })
})
