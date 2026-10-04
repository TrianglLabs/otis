import { mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, dialog, Notification, shell } from "electron"
import electronUpdater from "electron-updater"
import { describeError } from "../../inference/errors.js"
import { localConfigDirectory, localDataDirectory } from "../../local/paths.js"
import { loadLocalSettings, saveRemote } from "../../local/settings.js"
import { DESKTOP_CHANNELS, type DesktopEvent, type DesktopSnapshot } from "../contracts.js"
import type { SessionNotice } from "../wire.js"
import { type DesktopBackend, localBackend } from "./api.js"
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
/** The runtime serving the window: in this process, or an `otis serve` daemon. */
let backend: DesktopBackend | undefined
const stopBackend = () => backend?.shutdown().catch(() => {}) ?? Promise.resolve()
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
  const exit = () => {
    console.error(error)
    try {
      dialog.showErrorBox("Otis has to quit", describeError(error))
    } catch {
      // Not available before the app is ready.
    }
    app.exit(1)
  }
  setTimeout(exit, 10_000).unref()
  void stopBackend().finally(exit)
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

    const settings = await loadLocalSettings()
    // The last GUI workspace only applies when the shell handed us no cwd (Finder/Dock relaunch).
    let cwd: string | undefined = resolveWorkspaceCwd(
      process.env,
      process.cwd(),
      homedir(),
      settings.lastWorkspace,
    )
    try {
      await mkdir(cwd, { recursive: true })
    } catch (cause) {
      cwd = await recoverWorkspaceCwd(cause, {
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

    const focusWindow = () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    // Switching between the runtime here and a daemon is a restart: the window boots onto one
    // backend and keeps it.
    let current: DesktopBackend
    const relaunch = async () => {
      quitting = true
      await stopBackend()
      app.relaunch()
      app.exit(0)
    }
    const send = (event: DesktopEvent) => {
      if (mainWindow) sendToRenderer(mainWindow.webContents, DESKTOP_CHANNELS.event, event)
      // The status bar item rides the same ordered stream the renderer sees, so it can never
      // drift.
      if (event.type === "status") statusTrayGate?.applyLive(event.status)
    }
    const sendTerminal = (data: string) => {
      if (mainWindow) sendToRenderer(mainWindow.webContents, DESKTOP_CHANNELS.terminal, data)
    }
    // A finished session is announced only when the window is not in front; clicking the notice
    // shows that session.
    const notify = ({ runtime, title, failed }: SessionNotice) => {
      if (mainWindow?.isFocused() || !Notification.isSupported()) return
      const notice = new Notification({
        title,
        body: failed ? "Stopped with an error" : "Finished",
      })
      notice.on("click", () => {
        void current.call("focusSession", [runtime])
        focusWindow()
      })
      notice.show()
    }
    const checkForUpdates = async () => updater?.check()
    const installUpdate = async () => {
      // The replacement process must find the single-instance lock free and managed servers
      // stopped.
      await stopBackend()
      app.releaseSingleInstanceLock()
      updater?.install()
    }
    const startLocal = async () =>
      localBackend(
        await DesktopRuntime.create({
          cwd,
          checkForUpdates,
          installUpdate,
          version: app.getVersion(),
          platform: process.platform,
          notify,
          send,
          sendTerminal,
          // Packaged builds keep node-pty beside the resources; see electron-builder.yml.
          spawnPty: () =>
            (
              createRequire(__filename)(
                app.isPackaged ? join(process.resourcesPath, "node-pty") : "node-pty",
              ) as typeof import("node-pty")
            ).spawn,
        }),
      )
    const startRemote = async (remote: { url: string; token: string }, onClose: () => void) =>
      (await import("./remote.js")).connectRemote(remote, {
        platform: process.platform,
        version: app.getVersion(),
        onEvent: send,
        onTerminal: sendTerminal,
        onNotify: notify,
        onClose,
        checkForUpdates,
        installUpdate,
      })
    if (!settings.remote) current = await startLocal()
    else {
      const host = new URL(settings.remote.url).host
      try {
        current = await startRemote(settings.remote, () => {
          if (quitting) return
          void dialog
            .showMessageBox({
              type: "error",
              message: `Lost the connection to ${host}`,
              detail: "Reconnect once it is reachable again, or work on this machine.",
              buttons: ["Reconnect", "Work locally"],
              defaultId: 0,
              cancelId: 0,
            })
            .then(async ({ response }) => {
              if (response === 1) await saveRemote(undefined)
              await relaunch()
            })
        })
      } catch (error) {
        const { response } = await dialog.showMessageBox({
          type: "error",
          message: `Couldn't reach ${host}`,
          detail: [
            describeError(error),
            "Work on this machine instead, or quit and check the daemon.",
          ].join("\n\n"),
          buttons: ["Work locally", "Quit"],
          defaultId: 0,
          cancelId: 1,
        })
        if (response === 1) {
          app.quit()
          return
        }
        await saveRemote(undefined)
        current = await startLocal()
      }
    }
    backend = current
    registerDesktopIpc(current, {
      // A pairing is proven against the daemon before it is saved; the restart boots onto it.
      async connectRemote(url, token) {
        if (!URL.canParse(url)) return { ok: false, reason: "Enter the daemon's address as a URL." }
        try {
          const probe = await startRemote({ url, token }, () => {})
          await probe.call("getSnapshot", [])
          await probe.shutdown()
        } catch (error) {
          return { ok: false, reason: describeError(error) }
        }
        await saveRemote({ url, token })
        void relaunch()
        return { ok: true }
      },
      async disconnectRemote() {
        await saveRemote(undefined)
        void relaunch()
      },
    })
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
      // Tiling window managers on Linux size the window themselves; a minimum there breaks tiles.
      ...(process.platform === "linux" ? {} : { minWidth: 960, minHeight: 600 }),
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
      onRendererGone: () => current.rendererGone(),
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
    // OTIS_DEMO=1 opens the fixture home screen; "onboarding", "local" or a fixture session id
    // opens there.
    const demo =
      process.env.OTIS_DEMO === "1"
        ? "demo"
        : process.env.OTIS_DEMO
          ? `demo=${process.env.OTIS_DEMO}`
          : undefined
    const loaded = devServerUrl
      ? window.loadURL(demo ? `${devServerUrl}?${demo}` : devServerUrl)
      : window.loadFile(
          join(__dirname, "../renderer/index.html"),
          demo ? { search: demo } : undefined,
        )
    // did-fail-load owns the native recovery UI, including when the dev server has disappeared.
    void loaded.catch(() => {})

    // The macOS status bar item: glanceable activity (idle / working / needs approval) plus quick
    // actions, seeded from a snapshot and kept current by the status stream. macOS-only for now;
    // tray.ts is platform-clean so a Linux app indicator can follow the same shape.
    if (process.platform !== "darwin") return
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
          void current.call("focusSession", [runtime])
          focusWindow()
        },
        startNewSession: () => void current.call("startNewSession", []),
        stop: (runtime) => void current.call("stop", [runtime]),
        installUpdate: () => void current.call("installUpdate", []),
        respondToPermission: (id, allow) => void current.call("respondToPermission", [id, allow]),
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
      .call("getSnapshot", [])
      .then((snapshot) => gate.applySeed(snapshot as DesktopSnapshot))
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
    if (quitting || !backend || updater?.isInstalling()) return
    quitting = true
    event.preventDefault()
    void stopBackend().finally(() => app.exit(0))
  })
}
