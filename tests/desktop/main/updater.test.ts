import electronUpdater from "electron-updater"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopUpdateState } from "../../../src/desktop/contracts.js"
import { createInstallGuard, startAutoUpdates } from "../../../src/desktop/main/updater.js"

// No Electron process, release feed, credentials, or real downloads in these tests.
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    default: {
      autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(), quitAndInstall: vi.fn() }),
    },
  }
})

const { autoUpdater } = electronUpdater
const checkFeed = vi.mocked(autoUpdater.checkForUpdates)
const updateInfo = { version: "9.9.9", files: [], releaseDate: "2026-09-10", path: "fake.zip", sha512: "fake-hash" }
const downloadedEvent = { ...updateInfo, downloadedFile: "/preview/fake.zip" }
const result = (available = false, downloadPromise?: Promise<string[]>) => ({
  isUpdateAvailable: available,
  updateInfo,
  versionInfo: updateInfo,
  downloadPromise,
})

describe("startAutoUpdates", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    checkFeed.mockReset().mockResolvedValue(result())
    vi.mocked(autoUpdater.quitAndInstall).mockReset()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    autoUpdater.removeAllListeners()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function start(isPackaged = true) {
    const states: DesktopUpdateState[] = []
    const controller = startAutoUpdates({
      isPackaged,
      onState: (state) => states.push(state),
      onUpdaterError: () => () => {},
      onBeforeQuit: () => () => {},
      onInstallFailed: vi.fn(),
    })
    return { ...controller, states }
  }

  it("does not check, schedule, or install updates in development", async () => {
    const updater = start(false)
    await updater.check()
    updater.install()
    expect(updater.states).toEqual([{ status: "unavailable" }])
    expect(checkFeed).not.toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("shares the startup check with manual requests and allows a fresh check afterward", async () => {
    let resolve!: (value: ReturnType<typeof result>) => void
    checkFeed.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const updater = start()
    const first = updater.check()
    expect(updater.check()).toBe(first)
    expect(checkFeed).toHaveBeenCalledOnce()
    expect(updater.states).toEqual([{ status: "checking" }])
    resolve(result())
    await first
    expect(updater.states.at(-1)).toEqual({ status: "current" })
    await updater.check()
    expect(checkFeed).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(checkFeed).toHaveBeenCalledTimes(3)
  })

  it("keeps manual and hourly requests from overlapping a background download", async () => {
    let finish!: (files: string[]) => void
    checkFeed.mockResolvedValueOnce(
      result(
        true,
        new Promise((resolve) => {
          finish = resolve
        }),
      ),
    )
    const updater = start()
    const pending = updater.check()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updater.states.at(-1)).toEqual({ status: "downloading", version: "9.9.9" })
    expect(updater.check()).toBe(pending)
    expect(checkFeed).toHaveBeenCalledOnce()
    updater.install()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    autoUpdater.emit("update-downloaded", downloadedEvent)
    finish(["fake-update.zip"])
    await pending
    expect(updater.states.at(-1)).toEqual({ status: "ready", version: "9.9.9" })
    await updater.check()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(checkFeed).toHaveBeenCalledOnce()
    updater.install()
    updater.install()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
    expect(updater.isInstalling()).toBe(true)
  })

  it("does not replace a cached update's ready state when the check finishes", async () => {
    checkFeed.mockImplementationOnce(async () => {
      autoUpdater.emit("update-downloaded", downloadedEvent)
      return result(true, Promise.resolve(["cached.zip"]))
    })
    const updater = start()
    await updater.check()
    expect(updater.states).toEqual([{ status: "checking" }, { status: "ready", version: "9.9.9" }])
  })

  it("reports a failed check without rejecting and lets the user retry", async () => {
    checkFeed.mockRejectedValueOnce(new Error("offline"))
    const updater = start()
    await expect(updater.check()).resolves.toBeUndefined()
    expect(updater.states.at(-1)).toEqual({ status: "error", message: "Couldn’t check for updates. Please try again." })
    await updater.check()
    expect(updater.states.at(-1)).toEqual({ status: "current" })
  })

  it("reports download rejection and permits downloading again", async () => {
    checkFeed.mockImplementationOnce(async () => result(true, Promise.reject(new Error("reset"))))
    const updater = start()
    await expect(updater.check()).resolves.toBeUndefined()
    expect(updater.states.at(-1)).toEqual({
      status: "error",
      message: "The update couldn’t be downloaded. Please try again.",
    })
    await updater.check()
    expect(checkFeed).toHaveBeenCalledTimes(2)
  })

  it("handles updater error events without discarding an already downloaded update", async () => {
    const updater = start()
    await updater.check()
    autoUpdater.emit("error", new Error("updater error"))
    expect(updater.states.at(-1)?.status).toBe("error")
    autoUpdater.emit("update-downloaded", downloadedEvent)
    autoUpdater.emit("error", new Error("late error"))
    expect(updater.states.at(-1)).toEqual({ status: "ready", version: "9.9.9" })
  })

  it("does not claim to be up to date when this installation cannot check", async () => {
    checkFeed.mockResolvedValueOnce(null)
    const updater = start()
    await updater.check()
    expect(updater.states.at(-1)).toEqual({ status: "unavailable" })
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
