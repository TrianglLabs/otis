import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, type NativeImage, nativeImage } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { configureAppIcon } from "../../../src/desktop/main/app-icon.js"

vi.mock("electron", () => ({
  app: { dock: { setIcon: vi.fn() } },
  nativeImage: { createFromPath: vi.fn() },
}))

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const location = {
  packaged: false,
  resourcesPath: "/unused",
  mainDir: join(repoRoot, "out", "main"),
}
const image = { isEmpty: () => false } as NativeImage

describe("configureAppIcon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(nativeImage.createFromPath).mockReturnValue(image)
  })

  it("resolves the repo's resources/icon.png from the dev bundle in out/main", () => {
    expect(configureAppIcon({ ...location, platform: "linux" })).toBe(image)
    const path = join(repoRoot, "resources", "icon.png")
    expect(nativeImage.createFromPath).toHaveBeenCalledExactlyOnceWith(path)
    // Development and Linux builds need the checked-in export without Apple tooling at runtime.
    expect(existsSync(path)).toBe(true)
  })

  it("resolves inside Electron's resources directory in a packaged build", () => {
    const resourcesPath = join("/Applications", "Otis.app", "Contents", "Resources")
    configureAppIcon({
      packaged: true,
      resourcesPath,
      mainDir: join("/anywhere", "out", "main"),
      platform: "linux",
    })
    expect(nativeImage.createFromPath).toHaveBeenCalledExactlyOnceWith(
      join(resourcesPath, "icon.png"),
    )
  })

  it("leaves the packaged macOS icon entirely to the system, without loading a flat image", () => {
    expect(configureAppIcon({ ...location, packaged: true, platform: "darwin" })).toBeUndefined()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it.each([
    false,
    true,
  ])("provides the static export for Linux windows (packaged: %s)", (packaged) => {
    expect(configureAppIcon({ ...location, packaged, platform: "linux" })).toBe(image)
    expect(nativeImage.createFromPath).toHaveBeenCalledOnce()
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it("uses the exported icon in macOS development, where the bundle belongs to Electron", () => {
    expect(configureAppIcon({ ...location, platform: "darwin" })).toBe(image)
    expect(app.dock?.setIcon).toHaveBeenCalledExactlyOnceWith(image)
  })

  it("does not replace the development icon with an empty image when the export is missing", () => {
    vi.mocked(nativeImage.createFromPath).mockReturnValue({ isEmpty: () => true } as NativeImage)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(configureAppIcon({ ...location, platform: "darwin" })).toBeUndefined()
      expect(app.dock?.setIcon).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
