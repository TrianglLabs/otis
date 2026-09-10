import { describe, expect, it, vi } from "vitest"

// electron-updater pulls in Electron; the units under test never touch it, so a stub is enough.
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }))

import { checkForUpdatesSilently, createInstallGuard } from "../../../src/desktop/main/updater.js"

describe("checkForUpdatesSilently", () => {
  it("swallows a rejected version check", async () => {
    const updater = { checkForUpdates: vi.fn(async () => Promise.reject(new Error("offline"))) }
    expect(() => checkForUpdatesSilently(updater)).not.toThrow()
    // Let the rejection settle; an unhandled rejection would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it("swallows a rejected background download after a successful check", async () => {
    const updater = {
      checkForUpdates: vi.fn(async () => ({
        downloadPromise: Promise.reject(new Error("connection reset")),
      })),
    }
    expect(() => checkForUpdatesSilently(updater)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it("lets a healthy check and download complete untouched", async () => {
    const updater = {
      checkForUpdates: vi.fn(async () => ({ downloadPromise: Promise.resolve("done") })),
    }
    checkForUpdatesSilently(updater)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })
})

describe("createInstallGuard", () => {
  function harness(overrides: Partial<Parameters<typeof createInstallGuard>[0]> = {}) {
    const deps = {
      quitAndInstall: vi.fn(),
      onError: vi.fn((_: (error: Error) => void) => () => {}),
      onBeforeQuit: vi.fn((_: () => void) => () => {}),
      onFailed: vi.fn(),
      ...overrides,
    }
    createInstallGuard(deps)()
    return { deps }
  }

  it("leaves windows alone and calls quitAndInstall directly", () => {
    const { deps } = harness()
    expect(deps.quitAndInstall).toHaveBeenCalledOnce()
  })

  it("does not fail while the installer is still preparing — before-quit marks success-in-progress", () => {
    let beforeQuit: (() => void) | undefined
    let onError: ((error: Error) => void) | undefined
    const { deps } = harness({
      onBeforeQuit: vi.fn((listener: () => void) => {
        beforeQuit = listener
        return () => {}
      }),
      onError: vi.fn((listener: (error: Error) => void) => {
        onError = listener
        return () => {}
      }),
    })
    // Slow healthy prep: quiet for as long as it takes, then the app starts quitting.
    beforeQuit?.()
    onError?.(new Error("late ShipIt noise"))
    expect(deps.onFailed).not.toHaveBeenCalled()
  })

  it("fails on the updater's explicit error event", () => {
    let onError: ((error: Error) => void) | undefined
    const { deps } = harness({
      onError: vi.fn((listener: (error: Error) => void) => {
        onError = listener
        return () => {}
      }),
    })
    onError?.(new Error("ShipIt failed"))
    expect(deps.onFailed).toHaveBeenCalledOnce()
    onError?.(new Error("duplicate"))
    expect(deps.onFailed).toHaveBeenCalledOnce()
  })

  it("fails immediately when quitAndInstall throws", () => {
    const { deps } = harness({
      quitAndInstall: vi.fn(() => {
        throw new Error("installer unsupported")
      }),
    })
    expect(deps.onFailed).toHaveBeenCalledOnce()
  })

  it("never fails on elapsed time alone — silence means the app simply keeps running", () => {
    const { deps } = harness()
    expect(deps.onFailed).not.toHaveBeenCalled()
  })
})
