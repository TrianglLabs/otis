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
  // The isolated fixture requests native input so pointer capture is exercised with a real active pointer.
  window.webContents.on("console-message", async (details) => {
    const prefix = "OTIS_UI_INPUT:"
    if (!details.message.startsWith(prefix)) return
    const request = JSON.parse(details.message.slice(prefix.length))
    let error
    try {
      if (request.size) window.setContentSize(...request.size)
      for (const event of request.events ?? []) {
        window.webContents.sendInputEvent(event)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    } catch (cause) {
      error = String(cause)
    }
    await window.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent("otis-ui-input-done", { detail: ${JSON.stringify({ id: request.id, error })} }))`,
    )
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
