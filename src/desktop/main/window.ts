import { join } from "node:path"
import { app, BrowserWindow, type NativeImage, shell } from "electron"
import { DESKTOP_CHANNELS } from "../contracts.js"
import { handleRendererFailure, sendToRenderer } from "./renderer.js"

export function createMainWindow(options: {
  icon?: NativeImage
  onRendererGone: () => void
  isQuitting: () => boolean
}) {
  const window = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    title: app.getName(),
    icon: options.icon,
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

  handleRendererFailure(window, options)
  window.once("ready-to-show", () => window.show())
  // Keep the native app identity when the shared HTML document announces its "Otis" title.
  window.on("page-title-updated", (event) => event.preventDefault())

  const sendWindowState = () => {
    sendToRenderer(window.webContents, DESKTOP_CHANNELS.windowState, { fullscreen: window.isFullScreen() })
  }
  window.webContents.on("did-finish-load", sendWindowState)
  window.on("enter-full-screen", sendWindowState)
  window.on("leave-full-screen", sendWindowState)

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
  const loaded = devServerUrl
    ? window.loadURL(demo ? `${devServerUrl}?demo` : devServerUrl)
    : window.loadFile(join(__dirname, "../renderer/index.html"), demo ? { search: "demo" } : undefined)
  // did-fail-load owns the native recovery UI, including when the dev server has disappeared.
  void loaded.catch(() => {})

  return window
}
