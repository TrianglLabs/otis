import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  importHistory,
  initializeDevProfile,
  resolveDevData,
  shouldInitializeDevProfile,
} from "../../../src/desktop/main/dev-data.js"
import { loadLocalSettings, saveHostedApiKey } from "../../../src/local/settings.js"

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
    await expect(stat(join(options.otisHome, "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(join(options.otisHome, ".installed-profile-imported"), "utf8")).toBe(
      "1\n",
    )
  })

  it("retries an unsuccessful import without marking it complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-import-"))
    directories.push(root)
    const source = join(root, "config.json")
    const options = {
      sourceConfigDirectory: root,
      sourceDataDirectory: root,
      otisHome: join(root, "dev"),
    }
    await writeFile(source, "invalid config")
    await expect(initializeDevProfile(options)).rejects.toThrow()
    await expect(stat(join(options.otisHome, ".installed-profile-imported"))).rejects.toMatchObject(
      { code: "ENOENT" },
    )
    await rm(source)
    await saveHostedApiKey("fireworks", "fw_fake_retry_key", undefined, { file: source })
    await initializeDevProfile(options)
    expect(
      (await loadLocalSettings({ file: join(options.otisHome, "config.json"), env: {} }))
        .fireworksApiKey,
    ).toBe("fw_fake_retry_key")
  })

  it("only imports into the default development profile", () => {
    expect(shouldInitializeDevProfile({})).toBe(true)
    expect(shouldInitializeDevProfile({ otisHome: "  ", otisDevUserData: "  " })).toBe(true)
    expect(shouldInitializeDevProfile({ otisHome: "/tmp/test" })).toBe(false)
    expect(shouldInitializeDevProfile({ otisDevUserData: "/tmp/test" })).toBe(false)
  })

  it("imports setup and history once without restoring deliberately removed settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-import-"))
    directories.push(root)
    const sourceConfigDirectory = join(root, "installed-config")
    const sourceDataDirectory = join(root, "installed-data")
    const otisHome = join(root, "dev")
    const source = join(sourceConfigDirectory, "config.json")
    const file = join(otisHome, "config.json")
    await saveHostedApiKey("fireworks", "fw_fake_installed_key", undefined, { file: source })
    await put(sourceDataDirectory, "sessions/work/session_a.jsonl", "a\n")
    const original = await readFile(source, "utf8")

    const options = { sourceConfigDirectory, sourceDataDirectory, otisHome }
    await initializeDevProfile(options)
    expect((await loadLocalSettings({ file, env: {} })).fireworksApiKey).toBe(
      "fw_fake_installed_key",
    )
    expect(await read(otisHome, "sessions/work/session_a.jsonl")).toBe("a\n")
    await rm(file)
    await put(sourceDataDirectory, "sessions/work/session_b.jsonl", "b\n")
    await initializeDevProfile(options)
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
    // Later history arrives only on a refresh.
    await expect(stat(join(otisHome, "sessions/work/session_b.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await initializeDevProfile({ ...options, refresh: true })
    expect(await read(otisHome, "sessions/work/session_b.jsonl")).toBe("b\n")
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(source, "utf8")).toBe(original)
  })
})

describe("importHistory", () => {
  it("copies history one way, growing untouched copies and keeping development's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-history-"))
    directories.push(root)
    const installed = join(root, "installed")
    const dev = join(root, "dev")
    await put(installed, "sessions/work/new.jsonl", "1\n")
    await put(installed, "sessions/work/grown.jsonl", "1\n2\n")
    await put(dev, "sessions/work/grown.jsonl", "1\n")
    await put(installed, "sessions/work/continued.jsonl", "1\n2\n3\n")
    await put(dev, "sessions/work/continued.jsonl", "1\nmine\n")
    await put(dev, "sessions/work/deleted-upstream.jsonl", "kept\n")
    await put(installed, "memory/MEMORY.md", "- likes tea\n")
    await put(installed, "llama/model.gguf", "not history")

    await importHistory(installed, dev)
    expect(await read(dev, "sessions/work/new.jsonl")).toBe("1\n")
    expect(await read(dev, "sessions/work/grown.jsonl")).toBe("1\n2\n")
    // Development wrote to this one, so the installed copy no longer extends it.
    expect(await read(dev, "sessions/work/continued.jsonl")).toBe("1\nmine\n")
    expect(await read(dev, "sessions/work/deleted-upstream.jsonl")).toBe("kept\n")
    expect(await read(dev, "memory/MEMORY.md")).toBe("- likes tea\n")
    await expect(stat(join(dev, "llama/model.gguf"))).rejects.toMatchObject({ code: "ENOENT" })
    // Copies are as private as their originals, and nothing is left half-written.
    expect((await stat(join(dev, "sessions/work/new.jsonl"))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dev, "memory"))).mode & 0o777).toBe(0o700)
    await expect(stat(join(dev, "sessions/work/new.jsonl.importing"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    // The installed profile is only read.
    expect(await read(installed, "sessions/work/continued.jsonl")).toBe("1\n2\n3\n")
  })

  it("does nothing without an installed history", async () => {
    const root = await mkdtemp(join(tmpdir(), "otis-dev-history-"))
    directories.push(root)
    await importHistory(join(root, "missing"), join(root, "dev"))
    await expect(stat(join(root, "dev"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

async function put(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

const read = (root: string, path: string) => readFile(join(root, path), "utf8")

describe("resolveDevData", () => {
  it("returns undefined when the build is packaged", () => {
    expect(
      resolveDevData({ ...defaults, packaged: true, otisDevUserData: "/tmp/otis-dev" }),
    ).toBeUndefined()
    expect(resolveDevData({ ...defaults, packaged: true })).toBeUndefined()
  })

  it.each([
    undefined,
    "  ",
  ])("uses a persistent separate profile when the override is %s", (otisDevUserData) => {
    const path = join(defaults.appData, "otis-dev")
    expect(resolveDevData({ ...defaults, otisDevUserData })).toEqual({
      userData: path,
      otisHome: path,
    })
  })

  it("sandboxes userData and defaults the Otis data root to the same directory", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "/tmp/otis-dev" })).toEqual({
      userData: resolve("/tmp/otis-dev"),
      otisHome: resolve("/tmp/otis-dev"),
    })
  })

  it("keeps an explicit OTIS_HOME so a sandbox can be shaped differently", () => {
    expect(
      resolveDevData({
        ...defaults,
        otisDevUserData: "/tmp/otis-dev",
        otisHome: resolve("/tmp/otis-dev-home"),
      }),
    ).toEqual({
      userData: resolve("/tmp/otis-dev"),
      otisHome: resolve("/tmp/otis-dev-home"),
    })
  })

  it("treats a blank OTIS_HOME as unset and falls back to the sandbox", () => {
    expect(
      resolveDevData({ ...defaults, otisDevUserData: "/tmp/otis-dev", otisHome: "   " }),
    ).toEqual({
      userData: resolve("/tmp/otis-dev"),
      otisHome: resolve("/tmp/otis-dev"),
    })
  })

  it("trims the sandbox path so stray whitespace can't fork the isolation", () => {
    expect(resolveDevData({ ...defaults, otisDevUserData: "  /tmp/otis-dev  " })).toEqual({
      userData: resolve("/tmp/otis-dev"),
      otisHome: resolve("/tmp/otis-dev"),
    })
  })

  it("honors an explicit Otis home independently of the default Electron profile", () => {
    expect(resolveDevData({ ...defaults, otisHome: resolve("/tmp/otis-dev-home") })).toEqual({
      userData: join(defaults.appData, "otis-dev"),
      otisHome: resolve("/tmp/otis-dev-home"),
    })
  })

  it("resolves relative overrides to absolute paths for Electron", () => {
    expect(
      resolveDevData({ ...defaults, otisDevUserData: "./test-profile", otisHome: "./test-home" }),
    ).toEqual({
      userData: resolve("test-profile"),
      otisHome: resolve("test-home"),
    })
  })
})
