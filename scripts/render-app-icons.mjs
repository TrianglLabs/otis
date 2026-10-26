import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow } from "electron"

// Rasterizes the desktop app icons in resources/app-icons from their SVG sources with Electron's
// own Chromium, so the committed PNGs need no other renderer, and writes the previews the
// Appearance settings show. Run through `bun run build:desktop:app-icons`.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const dir = join(repo, "resources", "app-icons")
const previews = join(repo, "src", "desktop", "renderer", "assets", "app-icons")
const SIZE = 1024
// The settings tile is 56 points; previews carry its 2x rendition.
const PREVIEW = 112

app.disableHardwareAcceleration()
app.dock?.hide()
// Each icon closes its window; the app must outlive them.
app.on("window-all-closed", () => {})

async function capture(svg) {
  // One window per icon: a reused offscreen window fails its next capture, and a fresh one
  // occasionally fails its first, so the capture is tried again before giving up.
  for (let attempt = 1; ; attempt++) {
    const window = new BrowserWindow({
      show: false,
      width: SIZE,
      height: SIZE,
      useContentSize: true,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    })
    try {
      const page = `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
      // The capture follows the display's scale factor; the committed export is always 1024.
      return image.resize({ width: SIZE, quality: "best" })
    } catch (error) {
      if (attempt === 3) throw error
    } finally {
      window.destroy()
    }
  }
}

void app
  .whenReady()
  .then(async () => {
    await mkdir(previews, { recursive: true })
    for (const name of (await readdir(dir)).filter((file) => file.endsWith(".svg"))) {
      const image = await capture(await readFile(join(dir, name), "utf8"))
      const png = name.replace(/\.svg$/, ".png")
      await writeFile(join(dir, png), image.toPNG())
      await writeFile(
        join(previews, png),
        image.resize({ width: PREVIEW, quality: "best" }).toPNG(),
      )
      console.log(`rendered ${name}`)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
