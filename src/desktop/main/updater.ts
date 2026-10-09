import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"
import electronUpdater from "electron-updater"
import { runUpdateCommand } from "../../cli/update.js"
import { describeError } from "../../inference/errors.js"
import type { DesktopCliState, DesktopUpdateState } from "../contracts.js"

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
    if (installing) return Promise.resolve()
    // A download waiting for its restart keeps its row while the check looks for something newer;
    // an app left running for days must not offer the version it fetched on its first day.
    if (state.status !== "ready") report({ status: "checking" })
    pending = autoUpdater
      .checkForUpdates()
      .then(async (result) => {
        // A cached download can emit update-downloaded before the check promise resolves.
        const downloaded = state.status === "ready" ? state.version : undefined
        if (state.status !== "error") {
          if (result?.isUpdateAvailable && result.updateInfo.version !== downloaded)
            report({ status: "downloading", version: result.updateInfo.version })
          else if (!downloaded) report(result ? { status: "current" } : { status: "unavailable" })
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

/**
 * Keeps the `otis` command on this machine on the app's version: the installer's default folder
 * is looked at first, then the PATH. A command on another version is replaced from the release
 * the app runs, the way `otis update` would; one that cannot be written stays, with the reason
 * shown. Nothing happens without a command installed.
 */
export async function keepCliCurrent(deps: {
  version: string
  onState: (state: DesktopCliState | null) => void
  env?: NodeJS.ProcessEnv
  /** What `otis --version` says for a binary, or nothing when it does not run. */
  versionOf?: (path: string) => Promise<string | undefined>
  /** Replaces the binary with the release of `version`; rejects with the reason. */
  update?: (path: string, from: string) => Promise<void>
}) {
  const env = deps.env ?? process.env
  const home = env.HOME || homedir()
  const folders = [
    join(home, ".local", "bin"),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ]
  const versionOf =
    deps.versionOf ??
    (async (path: string) => {
      const { stdout } = await promisify(execFile)(path, ["--version"], { timeout: 5000 })
      return /^otis (\S+)/u.exec(stdout.trim())?.[1]
    })
  const update =
    deps.update ??
    ((path: string, version: string) =>
      runUpdateCommand(["--version", version], { execPath: path, stdout: { write: () => {} } }))
  for (const folder of new Set(folders)) {
    const path = join(folder, "otis")
    const version = await access(path, constants.X_OK).then(
      () => versionOf(path),
      () => undefined,
    )
    if (version === undefined) continue
    if (version === deps.version) return deps.onState({ status: "current", path, version })
    deps.onState({ status: "updating", path, version })
    try {
      await update(path, deps.version)
      return deps.onState({ status: "updated", path, version: deps.version })
    } catch (error) {
      return deps.onState({ status: "failed", path, version, message: describeError(error) })
    }
  }
  deps.onState(null)
}
