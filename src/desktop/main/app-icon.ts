import { join } from "node:path"
import { app, type NativeImage, nativeImage } from "electron"

/**
 * Packaged macOS apps use the native asset catalog; other platforms and Electron dev use its static
 * export. The main bundle lives in out/main; electron-builder copies the icons into the packaged
 * resources directory.
 */
export function configureAppIcon(options: {
  packaged: boolean
  resourcesPath: string
  mainDir: string
  platform: NodeJS.Platform
}): NativeImage | undefined {
  // A Dock image override would replace the system's Liquid Glass rendering and appearance
  // selection.
  if (options.platform === "darwin" && options.packaged) return undefined

  const root = options.packaged
    ? options.resourcesPath
    : join(options.mainDir, "..", "..", "resources")
  const path = join(root, "icon.png")
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    console.warn(`Unable to load the desktop icon: ${path}`)
    return undefined
  }
  if (options.platform === "darwin") app.dock?.setIcon(image)
  return image
}
