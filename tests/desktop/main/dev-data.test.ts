import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { initializeDevProfile, resolveDevData, shouldInitializeDevProfile } from "../../../src/desktop/main/dev-data.js"
import { loadLocalSettings, saveFireworksApiKey } from "../../../src/local/settings.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const defaults = {
  packaged: false,
  appData: resolve("test-app-data"),
  otisDevUserData: undefined,
  otisHome: undefined,
}

describe("development profile import", () => {
  it("allows a fresh development install with no installed profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-import-"))
    directories.push(root)
    const options = {
      sourceConfigDirectory: join(root, "missing-config"),
      sourceDataDirectory: join(root, "missing-data"),
      otisHome: join(root, "dev"),
    }
    await initializeDevProfile(options)
    await expect(stat(join(options.otisHome, "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(options.otisHome, ".installed-profile-imported"), "utf8")).toBe("1\n")
  })

  it("retries an unsuccessful import without marking it complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-import-"))
    directories.push(root)
    const source = join(root, "config.json")
    const options = { sourceConfigDirectory: root, sourceDataDirectory: root, otisHome: join(root, "dev") }
    await writeFile(source, "invalid config")
    await expect(initializeDevProfile(options)).rejects.toThrow()
    await expect(stat(join(options.otisHome, ".installed-profile-imported"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(source)
    await saveFireworksApiKey("fw_fake_retry_key", { file: source })
    await initializeDevProfile(options)
    expect((await loadLocalSettings({ file: join(options.otisHome, "config.json"), env: {} })).fireworksApiKey).toBe(
      "fw_fake_retry_key",
    )
  })

  it("only imports into the default development profile", () => {
    expect(shouldInitializeDevProfile({})).toBe(true)
    expect(shouldInitializeDevProfile({ otisHome: "  ", otisDevUserData: "  " })).toBe(true)
    expect(shouldInitializeDevProfile({ otisHome: "/tmp/test" })).toBe(false)
    expect(shouldInitializeDevProfile({ otisDevUserData: "/tmp/test" })).toBe(false)
  })

  it("imports setup once without copying sessions or restoring deliberately removed settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-import-"))
    directories.push(root)
    const sourceConfigDirectory = join(root, "installed-config")
    const sourceDataDirectory = join(root, "installed-data")
    const otisHome = join(root, "dev")
    const source = join(sourceConfigDirectory, "config.json")
    const file = join(otisHome, "config.json")
    await saveFireworksApiKey("fw_fake_installed_key", { file: source })
    await writeFile(join(sourceConfigDirectory, "session.jsonl"), "private conversation")
    const original = await readFile(source, "utf8")

    const options = { sourceConfigDirectory, sourceDataDirectory, otisHome }
    await initializeDevProfile(options)
    expect((await loadLocalSettings({ file, env: {} })).fireworksApiKey).toBe("fw_fake_installed_key")
    await expect(stat(join(otisHome, "session.jsonl"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(file)
    await initializeDevProfile(options)
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(source, "utf8")).toBe(original)
  })
})

describe("resolveDevData", () => {
  it("returns undefined when the build is packaged", () => {
    expect(resolveDevData({ ...defaults, packaged: true, otisDevUserData: "/tmp/otis-dev" })).toBeUndefined()
    expect(resolveDevData({ ...defaults, packaged: true })).toBeUndefined()
  })

  it.each([undefined, "  "])("uses a persistent separate profile when the override is %s", (otisDevUserData) => {
    const path = join(defaults.appData, "otis-dev")
    expect(resolveDevData({ ...defaults, otisDevUserData })).toEqual({ userData: path, otisHome: path })
  })

  it("sandboxes userData and defaults the Otis data root to the same directory", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "/tmp/otis-dev" })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })

  it("keeps an explicit OTIS_HOME so a sandbox can be shaped differently", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "/tmp/otis-dev", otisHome: "/tmp/otis-dev-home" })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev-home",
    })
  })

  it("treats a blank OTIS_HOME as unset and falls back to the sandbox", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "/tmp/otis-dev", otisHome: "   " })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })

  it("trims the sandbox path so stray whitespace can't fork the isolation", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "  /tmp/otis-dev  " })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })

  it("honors an explicit Otis home independently of the default Electron profile", () => {
    expect(resolveDevData({ ...defaults, otisHome: "/tmp/otis-dev-home" })).toEqual({
      userData: join(defaults.appData, "otis-dev"),
      otisHome: "/tmp/otis-dev-home",
    })
  })

  it("resolves relative overrides to absolute paths for Electron", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "./test-profile", otisHome: "./test-home" })).toEqual({
      userData: resolve("test-profile"),
      otisHome: resolve("test-home"),
    })
  })
})
