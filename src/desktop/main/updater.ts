import electronUpdater from "electron-updater"

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * GitHub Releases auto-update. Checks on launch and hourly; downloads in the background and reports
 * when a release is ready, leaving the restart decision to the user (the renderer shows the affordance).
 * Dev builds skip entirely; failures stay quiet — a missed update check is never worth an error dialog.
 */
export function startAutoUpdates(deps: {
  isPackaged: boolean
  onDownloaded: (version: string) => void
  /** Installer error event subscription (autoUpdater.on("error")); returns an unsubscribe. */
  onUpdaterError: (listener: (error: Error) => void) => () => void
  /** App quit-start subscription (app.once("before-quit")); returns an unsubscribe. */
  onBeforeQuit: (listener: () => void) => () => void
  /** Install didn't take (user cancelled, installer error): the app must explain and exit cleanly. */
  onInstallFailed: () => void
}): { install: () => void; isInstalling: () => boolean } {
  if (!deps.isPackaged) return { install: () => {}, isInstalling: () => false } // dev: no feed, no guard

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on("update-downloaded", (info) => deps.onDownloaded(info.version))
  autoUpdater.on("error", (error) => console.warn("Auto-update check failed:", error.message))

  const check = () => checkForUpdatesSilently(autoUpdater)
  check()
  setInterval(check, CHECK_INTERVAL_MS).unref()

  // While installing, the normal window-all-closed → app.quit() and before-quit interception must stand down:
  // quitAndInstall owns the quit, and app.exit(0) before it runs would kill the installer handoff.
  let installing = false
  return {
    isInstalling: () => installing,
    install: () => {
      installing = true
      return createInstallGuard({
        quitAndInstall: () => autoUpdater.quitAndInstall(),
        onError: deps.onUpdaterError,
        onBeforeQuit: deps.onBeforeQuit,
        onFailed: deps.onInstallFailed,
      })()
    },
  }
}

/** A failed version check or download is a skipped update, never a crash: both promises are swallowed. */
export function checkForUpdatesSilently(updater: {
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null | undefined>
}): void {
  updater
    .checkForUpdates()
    .then((result) => void result?.downloadPromise?.catch(() => {}))
    .catch(() => {})
}

/**
 * Decides install failure from installer lifecycle, never from elapsed time: macOS preparation can legitimately
 * take minutes on a slow disk, so a timer would abort healthy installs. Failure is the updater's error event or a
 * synchronous throw; success-in-progress is the app beginning to quit. Windows are left alone — the caller marks
 * the app as installing so its normal quit paths stand down and quitAndInstall owns the shutdown.
 */
export function createInstallGuard(deps: {
  quitAndInstall: () => void
  onError: (listener: (error: Error) => void) => () => void
  onBeforeQuit: (listener: () => void) => () => void
  onFailed: () => void
}): () => void {
  return () => {
    let settled = false
    const unError = deps.onError(() => fail())
    const unQuit = deps.onBeforeQuit(() => {
      settled = true
      unError()
    })
    const fail = () => {
      if (settled) return
      settled = true
      unError()
      unQuit()
      deps.onFailed()
    }
    try {
      deps.quitAndInstall()
    } catch {
      fail()
    }
  }
}
