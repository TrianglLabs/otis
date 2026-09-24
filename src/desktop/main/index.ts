import { mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, dialog, shell } from "electron"
import electronUpdater from "electron-updater"
import { localConfigDirectory, localDataDirectory } from "../../local/paths.js"
import { loadLocalSettings } from "../../local/settings.js"
import { DESKTOP_CHANNELS } from "../contracts.js"
import { configureAppIcon } from "./app-icon.js"
import { initializeDevProfile, resolveDevData, shouldInitializeDevProfile } from "./dev-data.js"
import { registerDesktopIpc } from "./ipc.js"
import { guardFrameNavigation, handleRendererFailure, sendToRenderer } from "./renderer.js"
import { DesktopRuntime } from "./runtime.js"
import { handleClosedOutput } from "./stdio.js"
import { createStatusTray, trayIconDir, trayStatusGate } from "./tray.js"
import { startAutoUpdates } from "./updater.js"
import { recoverWorkspaceCwd, resolveWorkspaceCwd } from "./workspace.js"

const { autoUpdater } = electronUpdater

handleClosedOutput(process.stdout)
handleClosedOutput(process.stderr)

let mainWindow: BrowserWindow | undefined
let runtime: DesktopRuntime | undefined
let updater: ReturnType<typeof startAutoUpdates> | undefined
let quitting = false
// The sole route for both tray status writers (live stream and seed); see trayStatusGate for why
// the seed is gated.
let statusTrayGate: ReturnType<typeof trayStatusGate> | undefined

app.setName(app.isPackaged ? "Otis" : "Otis Dev")
// Linux desktops match a window to its launcher entry and icon by app id. electron-builder names
// the entry after package.json's desktopName; set it here too so the id never depends on the
// packaged manifest, and so it holds when the entry is integrated later (AppImage tools).
if (process.platform === "linux") app.setDesktopName("ai.triangllabs.otis.desktop")

// A crash must not orphan a multi-gigabyte llama-server: stop it through the runtime's shutdown
// path, then exit with the original error instead of Electron's default of staying open.
const crash = (error: unknown) => {
  process.off("uncaughtException", crash)
  process.off("unhandledRejection", crash)
  quitting = true
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const exit = () => {
    console.error(error)
    try {
      dialog.showErrorBox("A JavaScript error occurred in the main process", detail)
    } catch {
      // Not available before the app is ready.
    }
    app.exit(1)
  }
  setTimeout(exit, 10_000).unref()
  void (runtime?.shutdown() ?? Promise.resolve()).catch(() => {}).finally(exit)
}
process.on("uncaughtException", crash)
process.on("unhandledRejection", crash)

// Isolate development before acquiring the lock or loading any settings, sessions or managed
// runtimes.
const devData = resolveDevData({
  packaged: app.isPackaged,
  appData: app.getPath("appData"),
  otisDevUserData: process.env.OTIS_DEV_USER_DATA,
  otisHome: process.env.OTIS_HOME,
})
// Capture the installed profile before redirecting OTIS_HOME to development.
const installedProfile =
  devData &&
  shouldInitializeDevProfile({
    otisDevUserData: process.env.OTIS_DEV_USER_DATA,
    otisHome: process.env.OTIS_HOME,
  })
    ? {
        sourceConfigDirectory: localConfigDirectory(),
        sourceDataDirectory: localDataDirectory(),
        otisHome: devData.otisHome,
      }
    : undefined
if (devData) {
  mkdirSync(devData.userData, { recursive: true, mode: 0o700 })
  app.setPath("userData", devData.userData)
  app.setPath("sessionData", devData.userData)
  // Default the Otis data root to the same sandbox; an explicit OTIS_HOME was already honored
  // above.
  process.env.OTIS_HOME = devData.otisHome
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    if (installedProfile) {
      try {
        await initializeDevProfile(installedProfile)
      } catch {
        dialog.showErrorBox(
          "Couldn't prepare the Otis Dev profile",
          "Your installed Otis profile has not been changed. Check available disk space and profile permissions, " +
            "then restart to retry. Set OTIS_DEV_USER_DATA to a separate directory to start without importing.",
        )
        app.quit()
        return
      }
    }
    const appIcon = configureAppIcon({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: __dirname,
      platform: process.platform,
    })

    // The last GUI workspace only applies when the shell handed us no cwd (Finder/Dock relaunch).
    const lastWorkspace = (await loadLocalSettings()).lastWorkspace
    let cwd: string | undefined = resolveWorkspaceCwd(
      process.env,
      process.cwd(),
      homedir(),
      lastWorkspace,
    )
    try {
      await mkdir(cwd, { recursive: true })
    } catch (cause) {
      cwd = await recoverWorkspaceCwd(cwd, cause, {
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
    if (!cwd) {
      app.quit()
      return
    }

    const current = await DesktopRuntime.create({
      cwd,
      checkForUpdates: async () => updater?.check(),
      installUpdate: async () => {
        // The replacement process must find the single-instance lock free and managed servers
        // stopped.
        await runtime?.shutdown().catch(() => {})
        app.releaseSingleInstanceLock()
        updater?.install()
      },
      version: app.getVersion(),
      platform: process.platform,
      send: (event) => {
        if (mainWindow) sendToRenderer(mainWindow.webContents, DESKTOP_CHANNELS.event, event)
        // The status bar item rides the same ordered stream the renderer sees, so it can never
        // drift.
        if (event.type === "status") statusTrayGate?.applyLive(event.status)
      },
    })
    runtime = current
    registerDesktopIpc(current)
    updater = startAutoUpdates({
      isPackaged: app.isPackaged,
      onState: (state) => current.setUpdateState(state),
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

    const window = new BrowserWindow({
      width: 1280,
      height: 832,
      minWidth: 960,
      minHeight: 600,
      title: app.getName(),
      icon: appIcon,
      backgroundColor: "#1A1A1A",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
      trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 16 } : undefined,
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    mainWindow = window
    handleRendererFailure(window, {
      onRendererGone: () => current.handleRendererGone(),
      isQuitting: () => quitting || Boolean(updater?.isInstalling()),
    })
    window.once("ready-to-show", () => window.show())
    // Keep the native app identity when the shared HTML document announces its "Otis" title.
    window.on("page-title-updated", (event) => event.preventDefault())
    window.on("closed", () => {
      mainWindow = undefined
    })
    const sendWindowState = () => {
      sendToRenderer(window.webContents, DESKTOP_CHANNELS.windowState, {
        fullscreen: window.isFullScreen(),
      })
    }
    window.webContents.on("did-finish-load", sendWindowState)
    window.on("enter-full-screen", sendWindowState)
    window.on("leave-full-screen", sendWindowState)
    // The renderer never navigates or opens windows itself; links go to the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
      return { action: "deny" }
    })
    window.webContents.on("will-navigate", (event) => event.preventDefault())
    const devServerUrl = process.env.ELECTRON_RENDERER_URL
    guardFrameNavigation(
      window,
      devServerUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href,
    )
    const demo = process.env.OTIS_DEMO === "1"
    const loaded = devServerUrl
      ? window.loadURL(demo ? `${devServerUrl}?demo` : devServerUrl)
      : window.loadFile(
          join(__dirname, "../renderer/index.html"),
          demo ? { search: "demo" } : undefined,
        )
    // did-fail-load owns the native recovery UI, including when the dev server has disappeared.
    void loaded.catch(() => {})

    // The macOS status bar item: glanceable activity (idle / working / needs approval) plus quick
    // actions, seeded from a snapshot and kept current by the status stream. macOS-only for now;
    // tray.ts is platform-clean so a Linux app indicator can follow the same shape.
    if (process.platform !== "darwin") return
    const focusWindow = () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    const tray = createStatusTray({
      appName: app.getName(),
      iconDir: trayIconDir({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        mainDir: __dirname,
      }),
      actions: {
        focusWindow,
        focusSession: (runtime) => {
          current.focusSession(runtime)
          focusWindow()
        },
        startNewSession: () => void current.startNewSession(),
        stop: () => current.stop(),
        installUpdate: () => void current.installUpdate(),
      },
    })
    if (!tray) return
    // Both the live stream (via the send fan-out above) and the seed below write to the tray. The
    // gate drops a seed that resolves after any live event — the seed's busy/phase were captured
    // before its session listing finished, so applying it then would roll a newer working/approval
    // icon back to idle.
    const gate = trayStatusGate(tray)
    statusTrayGate = gate
    void current
      .snapshot()
      .then((snapshot) => gate.applySeed(snapshot))
      .catch((error) => console.warn(`Unable to seed the status bar item: ${String(error)}`))
  })

  // v1 policy: one window, one workspace. Closing the window quits the app so no managed processes
  // outlive it. During an update install both quit paths stand down: quitAndInstall owns the
  // shutdown, and racing it with app.quit()/app.exit(0) would kill the installer handoff.
  app.on("window-all-closed", () => {
    if (updater?.isInstalling()) return
    app.quit()
  })

  app.on("before-quit", (event) => {
    if (quitting || !runtime || updater?.isInstalling()) return
    quitting = true
    event.preventDefault()
    void runtime.shutdown().finally(() => app.exit(0))
  })
}
