import { join } from "node:path"
import { app, type NativeImage, nativeImage } from "electron"

type IconLocation = { packaged: boolean; resourcesPath: string; mainDir: string }

/** The main bundle lives in out/main; electron-builder copies the icons into the packaged resources directory. */
export function appIconPath(options: IconLocation): string {
  const root = options.packaged ? options.resourcesPath : join(options.mainDir, "..", "..", "resources")
  return join(root, "icon.png")
}

/** Packaged macOS apps use the native asset catalog; other platforms and Electron dev use its static export. */
export function configureAppIcon(options: IconLocation & { platform: NodeJS.Platform }): NativeImage | undefined {
  // A Dock image override would replace the system's Liquid Glass rendering and appearance selection.
  if (options.platform === "darwin" && options.packaged) return undefined

  const path = appIconPath(options)
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    console.warn(`Unable to load the desktop icon: ${path}`)
    return undefined
  }
  if (options.platform === "darwin") app.dock?.setIcon(image)
  return image
}
