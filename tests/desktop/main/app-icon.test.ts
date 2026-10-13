import { existsSync, readFileSync } from "node:fs"
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
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
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
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it("uses the sized .ico in Windows development and the executable's icon when packaged", () => {
    expect(configureAppIcon({ ...location, platform: "win32" })).toBe(image)
    const path = join(repoRoot, "resources", "icon.ico")
    expect(nativeImage.createFromPath).toHaveBeenCalledExactlyOnceWith(path)
    expect(existsSync(path)).toBe(true)
    vi.clearAllMocks()
    expect(configureAppIcon({ ...location, packaged: true, platform: "win32" })).toBeUndefined()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
  })

  it("leaves the packaged macOS icon entirely to the system, without loading a flat image", () => {
    expect(configureAppIcon({ ...location, packaged: true, platform: "darwin" })).toBeUndefined()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
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

// Windows draws the title bar, taskbar, and Explorer icons from the .ico entry nearest each size.
describe("Windows icon", () => {
  it("holds one PNG entry per export size, 16 to 256, that electron-builder compiles in", () => {
    const ico = readFileSync(join(repoRoot, "resources", "icon.ico"))
    expect(ico.readUInt16LE(2)).toBe(1)
    const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const entry = 6 + 16 * index
      const offset = ico.readUInt32LE(entry + 12)
      return {
        size: ico.readUInt8(entry) || 256,
        png: ico.subarray(offset, offset + 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
      }
    })
    expect(entries).toEqual([16, 32, 64, 128, 256].map((size) => ({ size, png: true })))
    expect(readFileSync(join(repoRoot, "electron-builder.yml"), "utf8")).toMatch(
      /^win:(?:\n {2}.*)*\n {2}icon: resources\/icon\.ico$/m,
    )
  })
})

// Linux desktops resolve the launcher's icon name through the hicolor theme, which only indexes
// sizes up to 512. The packaged set must cover those sizes, or every launcher shows a placeholder.
describe("Linux icon set", () => {
  it("ships each hicolor size that electron-builder installs", () => {
    expect(readFileSync(join(repoRoot, "electron-builder.yml"), "utf8")).toMatch(
      /^linux:(?:\n {2}.*)*\n {2}icon: resources\/icons$/m,
    )
    for (const size of [16, 32, 64, 128, 256, 512]) {
      const png = readFileSync(join(repoRoot, "resources", "icons", `${size}x${size}.png`))
      expect(png.subarray(1, 4).toString()).toBe("PNG")
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${size}x${size}`).toEqual([size, size])
    }
  })
})
