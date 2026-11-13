import { join } from "node:path"
import { app, type BrowserWindow, type NativeImage, nativeImage } from "electron"
import type { AppIcon } from "../../local/settings.js"

/**
 * Whether the system shows the icon a running app sets. Linux Wayland sessions do not: GNOME's
 * dock and Hyprland desktops such as Omarchy read the icon of the installed desktop entry, and
 * Hyprland does not take window icons at all. A compositor started from a console reports the
 * session as tty, so the Wayland socket decides when the session type does not.
 */
export function appIconSupported(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return true
  if (env.XDG_SESSION_TYPE === "x11") return true
  return env.XDG_SESSION_TYPE !== "wayland" && !env.WAYLAND_DISPLAY
}

/**
 * Shows the chosen icon in the Dock on macOS and as the window icon elsewhere, and returns the
 * image for a window still to be created. A packaged macOS app carries the default as its bundle
 * icon, which the system draws in the Dock icon style the user picked, so the default hands the
 * Dock back to it there. A choice that leaves the image as it is does not reload it.
 */
export function createAppIcon(host: {
  packaged: boolean
  resourcesPath: string
  mainDir: string
  platform: NodeJS.Platform
}) {
  // The main bundle lives in out/main; electron-builder copies the icons into the packaged
  // resources directory.
  const dir = host.packaged
    ? join(host.resourcesPath, "app-icons")
    : join(host.mainDir, "..", "..", "resources", "app-icons")
  const bundled = host.packaged && host.platform === "darwin"
  let shown = bundled ? "bundle" : undefined
  return (choice: AppIcon, window?: BrowserWindow): NativeImage | undefined => {
    const path = bundled && choice === "obsidian" ? "bundle" : join(dir, `${choice}.png`)
    if (path === shown) return undefined
    shown = path
    // Electron's types omit it, but null clears the Dock's image back to the bundle icon.
    if (path === "bundle") return void app.dock?.setIcon(null as unknown as NativeImage)
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) {
      console.warn(`Unable to load the desktop icon: ${path}`)
      return undefined
    }
    if (host.platform === "darwin") app.dock?.setIcon(image)
    else window?.setIcon(image)
    return image
  }
}
