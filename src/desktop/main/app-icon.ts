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
 * image for a window still to be created. The Obsidian pairing shows its dark plate on a light
 * system appearance and its light plate on a dark one. A packaged macOS app already carries that
 * pairing as its bundle icon, which the system draws itself, so the pairing leaves the Dock alone
 * there until another icon has been shown. A choice that leaves the image as it is does not
 * reload it.
 */
export function createAppIcon(
  host: { packaged: boolean; resourcesPath: string; mainDir: string; platform: NodeJS.Platform },
  dark: () => boolean,
) {
  // The main bundle lives in out/main; electron-builder copies the icons into the packaged
  // resources directory.
  const dir = host.packaged
    ? join(host.resourcesPath, "app-icons")
    : join(host.mainDir, "..", "..", "resources", "app-icons")
  let shown = host.packaged && host.platform === "darwin" ? "bundle" : undefined
  return (choice: AppIcon, window?: BrowserWindow): NativeImage | undefined => {
    if (shown === "bundle" && choice === "obsidian") return undefined
    const file = choice === "obsidian" ? (dark() ? "obsidian-pearl" : "obsidian") : choice
    const path = join(dir, `${file === "obsidian-dark" ? "obsidian" : file}.png`)
    if (path === shown) return undefined
    shown = path
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
