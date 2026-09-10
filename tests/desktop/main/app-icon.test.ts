import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, type NativeImage, nativeImage } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appIconPath, configureAppIcon } from "../../../src/desktop/main/app-icon.js"

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
    // Development and Linux builds need the checked-in export without Apple tooling at runtime.
    expect(existsSync(path)).toBe(true)
  })

  it("resolves inside Electron's resources directory in a packaged build", () => {
    const resourcesPath = join("/Applications", "Otis.app", "Contents", "Resources")
    expect(appIconPath({ packaged: true, resourcesPath, mainDir: join("/anywhere", "out", "main") })).toBe(
      join(resourcesPath, "icon.png"),
    )
  })
})

describe("configureAppIcon", () => {
  beforeEach(() => vi.clearAllMocks())

  it("leaves the packaged macOS icon entirely to the system, without loading a flat image", () => {
    expect(configureAppIcon({ ...location, packaged: true, platform: "darwin" })).toBeUndefined()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it.each([false, true])("provides the static export for Linux windows (packaged: %s)", (packaged) => {
    const image = { isEmpty: () => false } as NativeImage
    vi.mocked(nativeImage.createFromPath).mockReturnValue(image)
    const options = { ...location, packaged, platform: "linux" as const }
    expect(configureAppIcon(options)).toBe(image)
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(appIconPath(options))
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it("uses the exported icon in macOS development, where the bundle belongs to Electron", () => {
    const image = { isEmpty: () => false } as NativeImage
    vi.mocked(nativeImage.createFromPath).mockReturnValue(image)
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
