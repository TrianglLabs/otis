import { join } from "node:path"
import { app, type NativeImage, nativeImage } from "electron"

/**
 * Packaged macOS apps use the native asset catalog and packaged Windows apps the icon compiled
 * into the executable; Linux and Electron dev use the static exports, the sized .ico on Windows.
 * The main bundle lives in out/main; electron-builder copies the icons into the packaged
 * resources directory.
 */
export function configureAppIcon(options: {
  packaged: boolean
  resourcesPath: string
  mainDir: string
  platform: NodeJS.Platform
}): NativeImage | undefined {
  // A Dock image override would replace the system's Liquid Glass rendering and appearance
  // selection; a Windows window without an icon of its own shows its executable's.
  if (options.packaged && (options.platform === "darwin" || options.platform === "win32"))
    return undefined

  const root = options.packaged
    ? options.resourcesPath
    : join(options.mainDir, "..", "..", "resources")
  const path = join(root, options.platform === "win32" ? "icon.ico" : "icon.png")
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    console.warn(`Unable to load the desktop icon: ${path}`)
    return undefined
  }
  if (options.platform === "darwin") app.dock?.setIcon(image)
  return image
}
