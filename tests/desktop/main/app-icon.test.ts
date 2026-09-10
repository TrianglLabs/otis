import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, type BrowserWindow, type NativeImage, nativeImage } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppIcon, appIconPath } from "../../../src/desktop/main/app-icon.js"
import { THEME_NAMES } from "../../../src/local/settings.js"

vi.mock("electron", () => ({
  app: { dock: { setIcon: vi.fn() } },
  nativeImage: { createFromPath: vi.fn() },
}))

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const location = { packaged: false, resourcesPath: "/unused", mainDir: join(repoRoot, "out", "main") }

describe("appIconPath", () => {
  it("resolves the repo's resources/icon.png from the dev bundle in out/main", () => {
    const path = appIconPath({ packaged: false, resourcesPath: "/unused", mainDir: join(repoRoot, "out", "main") })
    expect(path).toBe(join(repoRoot, "resources", "icon.png"))
    // The relative hop and the checked-in asset must both hold, or the dock silently shows Electron's icon.
    expect(existsSync(path)).toBe(true)
  })

  it("resolves inside Electron's resources directory in a packaged build", () => {
    const resourcesPath = join("/Applications", "Otis.app", "Contents", "Resources")
    expect(appIconPath({ packaged: true, resourcesPath, mainDir: join("/anywhere", "out", "main") })).toBe(
      join(resourcesPath, "icon.png"),
    )
    expect(appIconPath({ packaged: true, resourcesPath, mainDir: "/unused", theme: "graphite" })).toBe(
      join(resourcesPath, "icons", "graphite.png"),
    )
  })

  it("ships an icon for every selectable theme", () => {
    for (const theme of THEME_NAMES) expect(existsSync(appIconPath({ ...location, theme })), theme).toBe(true)
  })
})

describe("AppIcon", () => {
  beforeEach(() => vi.clearAllMocks())

  it("applies the saved theme, skips repeated status updates, and changes icons with the theme", () => {
    const graphite = { isEmpty: () => false } as NativeImage
    const purple = { isEmpty: () => false } as NativeImage
    vi.mocked(nativeImage.createFromPath).mockReturnValueOnce(graphite).mockReturnValueOnce(purple)
    const window = { setIcon: vi.fn() } as unknown as BrowserWindow
    const icons = new AppIcon(location)

    expect(icons.update("graphite", window)).toBe(graphite)
    expect(icons.update("graphite", window)).toBe(graphite)
    expect(nativeImage.createFromPath).toHaveBeenCalledTimes(1)
    expect(nativeImage.createFromPath).toHaveBeenLastCalledWith(join(repoRoot, "resources", "icons", "graphite.png"))

    expect(icons.update("default", window)).toBe(purple)
    expect(nativeImage.createFromPath).toHaveBeenCalledTimes(2)
    const setIcon = process.platform === "darwin" ? app.dock?.setIcon : window.setIcon
    expect(setIcon).toHaveBeenCalledTimes(2)
    expect(setIcon).toHaveBeenLastCalledWith(purple)
  })

  it("keeps the current icon if an asset is missing and does not retry on every status event", () => {
    const image = { isEmpty: () => false } as NativeImage
    vi.mocked(nativeImage.createFromPath)
      .mockReturnValueOnce(image)
      .mockReturnValueOnce({ isEmpty: () => true } as NativeImage)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const icons = new AppIcon(location)
      icons.update("default")
      expect(icons.update("graphite")).toBe(image)
      expect(icons.update("graphite")).toBe(image)
      expect(nativeImage.createFromPath).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
