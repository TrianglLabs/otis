const { app, BrowserWindow } = require("electron")
const { mkdirSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")

const [temporary, resources, ...themes] = process.argv.slice(2)
app.setPath("userData", join(temporary, "profile"))
app.commandLine.appendSwitch("force-device-scale-factor", "1")

void app.whenReady().then(async () => {
  app.dock?.hide()
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  })
  try {
    for (const theme of themes) {
      await window.loadFile(join(temporary, `${theme}.html`))
      const icon = await window.webContents.capturePage()
      const rendered = icon.resize({ width: 1024, height: 1024, quality: "best" })
      const pixels = rendered.toBitmap()
      // Check padding and the rounded cutouts, not just whether the PNG has an alpha channel.
      for (const [x, y] of [
        [0, 0],
        [50, 512],
        [973, 512],
        [145, 145],
        [878, 145],
        [145, 878],
        [878, 878],
      ]) {
        if (pixels[(y * 1024 + x) * 4 + 3] !== 0) throw new Error(`Icon padding or corners are opaque: ${theme}`)
      }
      const png = rendered.toPNG()
      writeFileSync(theme === "default" ? join(resources, "icon.png") : join(resources, "icons", `${theme}.png`), png)
      if (theme === "default") {
        const iconset = join(temporary, "icon.iconset")
        mkdirSync(iconset)
        for (const size of [16, 32, 128, 256, 512]) {
          for (const scale of [1, 2]) {
            const image = icon.resize({ width: size * scale, height: size * scale, quality: "best" })
            writeFileSync(join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), image.toPNG())
          }
        }
      }
    }
    console.log(`Generated ${themes.length} desktop theme icons from OtisMark and the renderer theme CSS.`)
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
