import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, type BrowserWindow, type NativeImage, nativeImage } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appIconSupported, createAppIcon } from "../../../src/desktop/main/app-icon.js"

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
const resourcesPath = join("/Applications", "Otis.app", "Contents", "Resources")
const packaged = { packaged: true, resourcesPath, mainDir: join("/anywhere", "out", "main") }
const image = { isEmpty: () => false } as NativeImage
const light = () => false

describe("createAppIcon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(nativeImage.createFromPath).mockReturnValue(image)
  })

  it("resolves the repo's resources/app-icons from the dev bundle in out/main", () => {
    expect(createAppIcon({ ...location, platform: "darwin" }, light)("obsidian-dark")).toBe(image)
    const path = join(repoRoot, "resources", "app-icons", "obsidian.png")
    expect(nativeImage.createFromPath).toHaveBeenCalledExactlyOnceWith(path)
    expect(existsSync(path)).toBe(true)
    expect(app.dock?.setIcon).toHaveBeenCalledExactlyOnceWith(image)
  })

  it("resolves inside Electron's resources directory in a packaged build", () => {
    createAppIcon({ ...packaged, platform: "darwin" }, light)("macro")
    expect(nativeImage.createFromPath).toHaveBeenCalledExactlyOnceWith(
      join(resourcesPath, "app-icons", "macro.png"),
    )
    expect(app.dock?.setIcon).toHaveBeenCalledExactlyOnceWith(image)
  })

  it("leaves a packaged Mac's bundle icon, which is the Obsidian pairing, until another is shown", () => {
    let dark = false
    const show = createAppIcon({ ...packaged, platform: "darwin" }, () => dark)
    expect(show("obsidian")).toBeUndefined()
    dark = true
    show("obsidian")
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
    show("macro")
    show("obsidian")
    expect(vi.mocked(nativeImage.createFromPath).mock.calls).toEqual([
      [join(resourcesPath, "app-icons", "macro.png")],
      [join(resourcesPath, "app-icons", "obsidian.png")],
    ])
    // Development builds show Electron's own icon, so the pairing is drawn there.
    createAppIcon({ ...location, platform: "darwin" }, () => false)("obsidian")
    expect(app.dock?.setIcon).toHaveBeenCalledTimes(3)
  })

  it("shows the Obsidian pairing's pearl plate on a light appearance and its dark one on dark", () => {
    let dark = false
    const show = createAppIcon({ ...location, platform: "darwin" }, () => dark)
    show("obsidian")
    dark = true
    show("obsidian")
    const dir = join(repoRoot, "resources", "app-icons")
    expect(vi.mocked(nativeImage.createFromPath).mock.calls).toEqual([
      [join(dir, "obsidian-pearl.png")],
      [join(dir, "obsidian.png")],
    ])
    expect(app.dock?.setIcon).toHaveBeenCalledTimes(2)
  })

  it("keeps the dark Obsidian plate in both appearances and does not reload an unchanged image", () => {
    let dark = false
    const show = createAppIcon({ ...location, platform: "darwin" }, () => dark)
    show("obsidian-dark")
    dark = true
    show("obsidian-dark")
    show("night")
    show("aqua")
    show("ember")
    const dir = join(repoRoot, "resources", "app-icons")
    expect(vi.mocked(nativeImage.createFromPath).mock.calls).toEqual([
      [join(dir, "obsidian.png")],
      [join(dir, "night.png")],
      [join(dir, "aqua.png")],
      [join(dir, "ember.png")],
    ])
  })

  it("sets the window icon outside macOS", () => {
    const window = { setIcon: vi.fn() } as unknown as BrowserWindow
    const show = createAppIcon({ ...packaged, platform: "win32" }, light)
    expect(show("obsidian-dark")).toBe(image)
    show("night", window)
    expect(window.setIcon).toHaveBeenCalledExactlyOnceWith(image)
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })

  it("keeps the current icon instead of showing an empty image when an export is missing", () => {
    vi.mocked(nativeImage.createFromPath).mockReturnValue({ isEmpty: () => true } as NativeImage)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(createAppIcon({ ...location, platform: "darwin" }, light)("macro")).toBeUndefined()
      expect(app.dock?.setIcon).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("appIconSupported", () => {
  it("offers icons on macOS, Windows, and Linux X11 but not in a Linux Wayland session", () => {
    expect(appIconSupported("darwin", { XDG_SESSION_TYPE: "wayland" })).toBe(true)
    expect(appIconSupported("win32", {})).toBe(true)
    expect(appIconSupported("linux", { XDG_SESSION_TYPE: "x11" })).toBe(true)
    expect(appIconSupported("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(false)
    // A compositor started from a console reports tty, or nothing, with the socket set.
    expect(appIconSupported("linux", { WAYLAND_DISPLAY: "wayland-1" })).toBe(false)
    expect(
      appIconSupported("linux", { XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-1" }),
    ).toBe(false)
    expect(
      appIconSupported("linux", { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-1" }),
    ).toBe(true)
    expect(appIconSupported("linux", {})).toBe(true)
  })
})

// The alternates ship beside the bundled icon and carry the same margin, so the Dock sizes them
// alike.
describe("Alternate app icons", () => {
  it("packages a 1024-pixel PNG with transparent margins for every alternate", () => {
    expect(readFileSync(join(repoRoot, "electron-builder.yml"), "utf8")).toMatch(
      /- from: resources\/app-icons\n {4}to: app-icons\n/,
    )
    for (const name of ["obsidian", "obsidian-pearl", "macro", "aqua", "night", "ember"]) {
      const png = readFileSync(join(repoRoot, "resources", "app-icons", `${name}.png`))
      expect(png.subarray(1, 4).toString()).toBe("PNG")
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], name).toEqual([1024, 1024])
      // RGBA: Electron's capture keeps the transparent margin.
      expect(png.readUInt8(25), name).toBe(6)
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
