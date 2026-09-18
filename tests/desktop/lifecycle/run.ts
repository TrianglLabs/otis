import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, dialog } from "electron"
import { handleRendererFailure, sendToRenderer } from "../../../src/desktop/main/renderer.js"
import { handleClosedOutput } from "../../../src/desktop/main/stdio.js"

const output = process.argv[2]
app.setPath("userData", join(output, "profile"))
handleClosedOutput(process.stdout)
handleClosedOutput(process.stderr)

function finish(error?: unknown) {
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(
      error
        ? { error: String(error) }
        : {
            brokenOutputPipes: "survived",
            crashedRendererDelivery: "skipped",
            rendererReload: "recovered",
            unexpectedErrors: 0,
          },
    ),
    { mode: 0o600 },
  )
  app.exit(error ? 1 : 0)
}

// Fail instead of showing Electron's uncaught-exception dialog in this unattended test.
process.on("uncaughtException", finish)
process.on("unhandledRejection", finish)

void app
  .whenReady()
  .then(async () => {
    let brokenPipes = 0
    for (const stream of [process.stdout, process.stderr]) {
      stream.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") brokenPipes++
      })
    }
    const disconnected = new Promise<void>((resolve) => process.stdin.once("data", () => resolve()))
    process.stdout.write("READY\n")
    await disconnected
    console.log("stdout after harness disconnect")
    console.error("stderr after harness disconnect")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(brokenPipes, 2)
    console.error("later diagnostic on the same broken pipe")

    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    let stopped = 0
    let recoveries = 0
    // The unit tests exercise the user's choices. Here the native renderer really crashes and is replaced.
    dialog.showMessageBox = async () => {
      recoveries++
      assert.equal(stopped, 1)
      return { response: 0, checkboxChecked: false }
    }
    handleRendererFailure(window, {
      onRendererGone: () => {
        stopped++
        assert.equal(sendToRenderer(window.webContents, "otis:test", "unavailable"), false)
      },
      isQuitting: () => false,
    })
    await window.loadURL("data:text/html,<title>Otis lifecycle test</title><p>Recovered window</p>")
    const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()))
    window.webContents.forcefullyCrashRenderer()
    await reloaded
    assert.equal(stopped, 1)
    assert.equal(recoveries, 1)
    assert.equal(window.webContents.isCrashed(), false)
    assert.equal(
      await window.webContents.executeJavaScript("document.querySelector('p').textContent"),
      "Recovered window",
    )
    assert.equal(sendToRenderer(window.webContents, "otis:test", "recovered"), true)
    finish()
  })
  .catch(finish)
