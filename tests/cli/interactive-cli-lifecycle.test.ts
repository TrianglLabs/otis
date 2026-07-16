import { describe, expect, it, vi } from "vitest"
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
