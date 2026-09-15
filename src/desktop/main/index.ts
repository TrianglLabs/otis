import { mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { app, type BrowserWindow, dialog } from "electron"
import electronUpdater from "electron-updater"
import { loadLocalSettings } from "../../local/settings.js"
import { DESKTOP_CHANNELS } from "../contracts.js"
import { configureAppIcon } from "./app-icon.js"
import { resolveDevData } from "./dev-data.js"
import { registerDesktopIpc } from "./ipc.js"
import { DesktopRuntime } from "./runtime.js"
import { createStatusTray, type StatusTray, trayIconDir, trayStatusGate } from "./tray.js"
import { startAutoUpdates } from "./updater.js"
import { createMainWindow } from "./window.js"
import { recoverWorkspaceCwd, resolveWorkspaceCwd } from "./workspace.js"

const { autoUpdater } = electronUpdater

let mainWindow: BrowserWindow | undefined
let runtime: DesktopRuntime | undefined
let updater: ReturnType<typeof startAutoUpdates> | undefined
let statusTray: StatusTray | undefined
// The sole route for both tray status writers (live stream and seed); see trayStatusGate for why the seed is gated.
let statusTrayGate: ReturnType<typeof trayStatusGate> | undefined

// In dev the binary is Electron's; keep the product name consistent with packaged builds.
app.setName("Otis")

// Dev affordance: point a development build at its own sandbox so it can run beside the installed app —
// the single-instance lock and Electron state follow it as userData, and (unless OTIS_HOME is set) so do
// settings, sessions, skills, and the llama runtime. Never active when packaged.
const devData = resolveDevData({
  packaged: app.isPackaged,
  otisDevUserData: process.env.OTIS_DEV_USER_DATA,
  otisHome: process.env.OTIS_HOME,
})
if (devData) {
  // Electron requires the userData directory to exist; it won't create a fresh path itself, so a new
  // OTIS_DEV_USER_DATA would abort startup. Runs at module scope, so it must be synchronous.
  mkdirSync(devData.userData, { recursive: true })
  app.setPath("userData", devData.userData)
  // Default the Otis data root to the same sandbox; an explicit OTIS_HOME was already honored above.
  process.env.OTIS_HOME = devData.otisHome
}

async function workspaceCwd() {
  // The last GUI workspace only applies when the shell handed us no cwd (Finder/Dock relaunch).
  const lastWorkspace = (await loadLocalSettings()).lastWorkspace
  const cwd = resolveWorkspaceCwd(process.env, process.cwd(), homedir(), lastWorkspace)
  try {
    await mkdir(cwd, { recursive: true })
    return cwd
  } catch (cause) {
    return recoverWorkspaceCwd(cwd, cause, {
      async choose(title, detail) {
        const { response } = await dialog.showMessageBox({
          type: "error",
          message: title,
          detail,
          buttons: ["Choose a Folder…", "Quit"],
          defaultId: 0,
          cancelId: 1,
        })
        return response === 0 ? "pick" : "quit"
      },
      async pickFolder() {
        const result = await dialog.showOpenDialog({
          title: "Choose a workspace folder",
          properties: ["openDirectory", "createDirectory"],
        })
        return result.canceled ? undefined : result.filePaths[0]
      },
      mkdir: (path) => mkdir(path, { recursive: true }),
      showError: (title, detail) => dialog.showErrorBox(title, detail),
    })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    const appIcon = configureAppIcon({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: __dirname,
      platform: process.platform,
    })
    const cwd = await workspaceCwd()
    if (!cwd) {
      app.quit()
      return
    }
    runtime = await DesktopRuntime.create({
      cwd,
      checkForUpdates: async () => updater?.check(),
      installUpdate: async () => {
        // The replacement process must find the single-instance lock free and managed servers stopped.
        await runtime?.shutdown().catch(() => {})
        app.releaseSingleInstanceLock()
        updater?.install()
      },
      version: app.getVersion(),
      platform: process.platform,
      send: (event) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(DESKTOP_CHANNELS.event, event)
        }
        // The status bar item rides the same ordered stream the renderer sees, so it can never drift.
        if (event.type === "status") statusTrayGate?.applyLive(event.status)
      },
    })
    registerDesktopIpc(runtime)
    updater = startAutoUpdates({
      isPackaged: app.isPackaged,
      onState: (state) => runtime?.setUpdateState(state),
      onUpdaterError: (listener) => {
        autoUpdater.on("error", listener)
        return () => autoUpdater.removeListener("error", listener)
      },
      onBeforeQuit: (listener) => {
        app.once("before-quit", listener)
        return () => app.removeListener("before-quit", listener)
      },
      onInstallFailed: () => {
        dialog.showErrorBox(
          "The update couldn't be installed",
          "Otis will now close. Nothing was lost — reopen the app to keep working on the current version.",
        )
        app.exit(1)
      },
    })

    mainWindow = createMainWindow(appIcon)
    mainWindow.on("closed", () => {
      mainWindow = undefined
    })
    mainWindow.webContents.on("render-process-gone", () => {
      runtime?.handleRendererGone()
    })

    // The macOS status bar item: glanceable activity (idle / working / needs approval) plus quick actions,
    // seeded from a snapshot and kept current by the status stream. macOS-only for now; tray.ts is
    // platform-clean so a Linux app indicator can follow the same shape.
    if (process.platform === "darwin" && runtime) {
      const current = runtime
      statusTray = createStatusTray({
        iconDir: trayIconDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname }),
        actions: {
          focusWindow: () => {
            const window = mainWindow
            if (!window) return
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
          },
          startNewSession: () => void current.startNewSession(),
          stop: () => current.stop(),
          installUpdate: () => void current.installUpdate(),
        },
      })
      // Both the live stream (via the send fan-out above) and the seed below write to the tray. The gate
      // drops a seed that resolves after any live event — the seed's busy/phase were captured before its
      // session listing finished, so applying it then would roll a newer working/approval icon back to idle.
      const trayGate = statusTray ? trayStatusGate(statusTray) : undefined
      statusTrayGate = trayGate
      void current
        .snapshot()
        .then((snapshot) => trayGate?.applySeed(snapshot))
        .catch((error) => console.warn(`Unable to seed the status bar item: ${String(error)}`))
    }
  })

  // v1 policy: one window, one workspace. Closing the window quits the app so no managed processes outlive it.
  // During an update install both quit paths stand down: quitAndInstall owns the shutdown, and racing it with
  // app.quit()/app.exit(0) would kill the installer handoff.
  app.on("window-all-closed", () => {
    if (updater?.isInstalling()) return
    app.quit()
  })

  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting || !runtime || updater?.isInstalling()) return
    quitting = true
    event.preventDefault()
    void runtime.shutdown().finally(() => app.exit(0))
  })
}
