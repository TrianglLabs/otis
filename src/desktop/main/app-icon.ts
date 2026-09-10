import { join } from "node:path"
import { app, type BrowserWindow, type NativeImage, nativeImage } from "electron"
import type { ThemeName } from "../../local/settings.js"

type IconLocation = { packaged: boolean; resourcesPath: string; mainDir: string }

/** The main bundle lives in out/main; electron-builder copies the icons into the packaged resources directory. */
export function appIconPath(options: IconLocation & { theme?: ThemeName }): string {
  const root = options.packaged ? options.resourcesPath : join(options.mainDir, "..", "..", "resources")
  return !options.theme || options.theme === "default"
    ? join(root, "icon.png")
    : join(root, "icons", `${options.theme}.png`)
}

/** Updates native icons on theme transitions, without doing image work for ordinary streaming status events. */
export class AppIcon {
  #theme: ThemeName | undefined
  #image: NativeImage | undefined

  constructor(private readonly location: IconLocation) {}

  update(theme: ThemeName, window?: BrowserWindow): NativeImage | undefined {
    if (theme === this.#theme) return this.#image
    this.#theme = theme
    const path = appIconPath({ ...this.location, theme })
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) {
      console.warn(`Unable to load the desktop icon: ${path}`)
      return this.#image
    }
    this.#image = image
    if (process.platform === "darwin") app.dock?.setIcon(image)
    else window?.setIcon(image)
    return image
  }
}
