import { app, type BrowserWindow } from "electron"
import { DESKTOP_CHANNELS } from "../contracts.js"
import { registerDesktopIpc } from "./ipc.js"
import { DesktopRuntime } from "./runtime.js"
import { createMainWindow } from "./window.js"

let mainWindow: BrowserWindow | undefined
let runtime: DesktopRuntime | undefined

// In dev the binary is Electron's; set the product identity explicitly until packaging owns it.
app.setName("Otis")

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
    runtime = await DesktopRuntime.create({
      cwd: process.env.OTIS_WORKSPACE ?? process.cwd(),
      version: app.getVersion(),
      platform: process.platform,
      send: (event) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(DESKTOP_CHANNELS.event, event)
        }
      },
    })
    registerDesktopIpc(runtime)

    mainWindow = createMainWindow()
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
