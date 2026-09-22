import electronUpdater from "electron-updater"
import type { DesktopUpdateState } from "../contracts.js"

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * GitHub Releases auto-update. Checks on launch and hourly; downloads in the background and reports
 * progress to Settings, leaving the restart decision to the user. Automatic and manual checks share
 * one in-flight operation, including its download. Dev builds skip entirely; failures never open an
 * error dialog.
 */
export function startAutoUpdates(deps: {
  isPackaged: boolean
  onState: (state: DesktopUpdateState) => void
  /** Installer error event subscription (autoUpdater.on("error")); returns an unsubscribe. */
  onUpdaterError: (listener: (error: Error) => void) => () => void
  /** App quit-start subscription (app.once("before-quit")); returns an unsubscribe. */
  onBeforeQuit: (listener: () => void) => () => void
  /**
   * Install didn't take (user cancelled, installer error): the app must explain and exit cleanly.
   */
  onInstallFailed: () => void
}): { check: () => Promise<void>; install: () => void; isInstalling: () => boolean } {
  if (!deps.isPackaged) {
    deps.onState({ status: "unavailable" })
    return { check: async () => {}, install: () => {}, isInstalling: () => false }
  }

  let state: DesktopUpdateState = { status: "idle" }
  let pending: Promise<void> | undefined
  let installing = false
  const report = (next: DesktopUpdateState) => {
    state = next
    deps.onState(next)
  }
  const reportError = () => {
    if (installing || state.status === "ready" || state.status === "error") return
    report({
      status: "error",
      message:
        state.status === "downloading"
          ? "The update couldn’t be downloaded. Please try again."
          : "Couldn’t check for updates. Please try again.",
    })
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on("update-downloaded", (info) => report({ status: "ready", version: info.version }))
  autoUpdater.on("error", (error) => {
    console.warn("Auto-update failed:", error.message)
    reportError()
  })

  const check = (): Promise<void> => {
    if (pending) return pending
    if (installing || state.status === "ready") return Promise.resolve()
    report({ status: "checking" })
    pending = autoUpdater
      .checkForUpdates()
      .then(async (result) => {
        // A cached download can emit update-downloaded before the check promise resolves.
        if (state.status !== "ready" && state.status !== "error") {
          if (!result) report({ status: "unavailable" })
          else if (result.isUpdateAvailable)
            report({ status: "downloading", version: result.updateInfo.version })
          else report({ status: "current" })
        }
        await result?.downloadPromise
      })
      // Both the version check and download may reject, with or without an error event.
      .catch(reportError)
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  void check()
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref()

  // While installing, the normal window-all-closed → app.quit() and before-quit interception must
  // stand down: quitAndInstall owns the quit, and app.exit(0) before it runs would kill the
  // installer handoff.
  return {
    check,
    isInstalling: () => installing,
    install: () => {
      if (installing || state.status !== "ready") return
      installing = true
      // Install failure is decided from installer lifecycle, never from elapsed time: macOS
      // preparation can legitimately take minutes on a slow disk, so a timer would abort healthy
      // installs. Failure is the updater's error event or a synchronous throw; success-in-progress
      // is the app beginning to quit. Windows are left alone — the app is marked as installing
      // above so its normal quit paths stand down and quitAndInstall owns the shutdown.
      let settled = false
      const unError = deps.onUpdaterError(() => fail())
      const unQuit = deps.onBeforeQuit(() => {
        settled = true
        unError()
      })
      const fail = () => {
        if (settled) return
        settled = true
        unError()
        unQuit()
        deps.onInstallFailed()
      }
      try {
        autoUpdater.quitAndInstall()
      } catch {
        fail()
      }
    },
  }
}
