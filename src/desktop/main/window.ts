import { join } from "node:path"
import { BrowserWindow, shell } from "electron"

export function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    title: "Otis",
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

  window.once("ready-to-show", () => window.show())

  // The renderer never navigates or opens windows itself; links go to the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const demo = process.env.OTIS_DEMO === "1"
  if (devServerUrl) window.loadURL(demo ? `${devServerUrl}?demo` : devServerUrl)
  else window.loadFile(join(__dirname, "../renderer/index.html"), demo ? { search: "demo" } : undefined)

  return window
}
