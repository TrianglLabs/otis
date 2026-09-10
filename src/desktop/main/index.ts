import { mkdir } from "node:fs/promises"
import { app, type BrowserWindow, dialog } from "electron"
import { DESKTOP_CHANNELS } from "../contracts.js"
import { AppIcon } from "./app-icon.js"
import { registerDesktopIpc } from "./ipc.js"
import { DesktopRuntime } from "./runtime.js"
import { createMainWindow } from "./window.js"
import { recoverWorkspaceCwd, resolveWorkspaceCwd } from "./workspace.js"

let mainWindow: BrowserWindow | undefined
let runtime: DesktopRuntime | undefined

// In dev the binary is Electron's; keep the product name consistent with packaged builds.
app.setName("Otis")

async function workspaceCwd() {
  const cwd = resolveWorkspaceCwd(process.env, process.cwd())
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
    const appIcon = new AppIcon({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: __dirname,
    })
    const cwd = await workspaceCwd()
    if (!cwd) {
      app.quit()
      return
    }
    runtime = await DesktopRuntime.create({
      cwd,
      version: app.getVersion(),
      platform: process.platform,
      send: (event) => {
        if (event.type === "status") appIcon.update(event.status.theme, mainWindow)
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(DESKTOP_CHANNELS.event, event)
        }
      },
    })
    registerDesktopIpc(runtime)

    // Apply the saved theme before showing the window, including in packaged apps.
    mainWindow = createMainWindow(appIcon.update((await runtime.snapshot()).theme))
    mainWindow.on("closed", () => {
      mainWindow = undefined
    })
    mainWindow.webContents.on("render-process-gone", () => {
      runtime?.handleRendererGone()
    })
  })

  // v1 policy: one window, one workspace. Closing the window quits the app so no managed processes outlive it.
  app.on("window-all-closed", () => {
    app.quit()
  })

  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting || !runtime) return
    quitting = true
    event.preventDefault()
    void runtime.shutdown().finally(() => app.exit(0))
  })
}
