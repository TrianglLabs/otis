const { app, BrowserWindow, session } = require("electron")
const { join } = require("node:path")

const output = process.argv[2]
app.setPath("userData", join(output, "user-data"))
const timeout = setTimeout(() => {
  console.error("Desktop UI checks timed out")
  app.exit(1)
}, 60_000)

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_request, done) =>
    done({ cancel: true }),
  )
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer exited", details.reason)
    app.exit(1)
  })
  try {
    await window.loadFile(join(output, "index.html"))
    const result = await window.webContents.executeJavaScript("window.runDesktopUiChecks()")
    console.log(JSON.stringify(result, null, 2))
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})
