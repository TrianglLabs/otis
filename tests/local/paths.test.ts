import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, join, resolve } from "node:path"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  childProcessEnvironment,
  extractZip,
  findOnPath,
  llamaServerRecordsDirectory,
  localConfigDirectory,
  localDataDirectory,
  shellCommand,
  tarExecutable,
  terminateProcessTree,
} from "../../src/local/paths.js"

const originalHome = process.env.OTIS_HOME
afterEach(() => {
  if (originalHome === undefined) delete process.env.OTIS_HOME
  else process.env.OTIS_HOME = originalHome
})

describe("childProcessEnvironment", () => {
  it("does not expose any hosted provider credential to child commands", () => {
    const source = {
      PATH: "/usr/bin",
      FIREWORKS_API_KEY: "fw_secret",
      TOGETHER_API_KEY: "tg_secret",
      BASETEN_API_KEY: "bt_secret",
      PRIME_API_KEY: "pi_secret",
      HF_TOKEN: "hf_token",
    }

    expect(childProcessEnvironment(source)).toEqual({ PATH: "/usr/bin", HF_TOKEN: "hf_token" })
    expect(source).toMatchObject({
      FIREWORKS_API_KEY: "fw_secret",
      TOGETHER_API_KEY: "tg_secret",
      BASETEN_API_KEY: "bt_secret",
      PRIME_API_KEY: "pi_secret",
    })
  })
})

describe("llamaServerRecordsDirectory", () => {
  it("lives beside the managed runtime and model caches", () => {
    process.env.OTIS_HOME = "/tmp/otis-home"
    expect(llamaServerRecordsDirectory()).toBe(join(resolve("/tmp/otis-home"), "llama", "servers"))
  })
})

const windows = process.platform === "win32"

describe("platform directories on Windows", () => {
  afterEach(() => vi.unstubAllEnvs())

  it.skipIf(!windows)("keep configuration in the roaming profile and data in the local one", () => {
    delete process.env.OTIS_HOME
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming")
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\dev\\AppData\\Local")
    expect(localConfigDirectory()).toBe("C:\\Users\\dev\\AppData\\Roaming\\otis")
    expect(localDataDirectory()).toBe("C:\\Users\\dev\\AppData\\Local\\otis")
  })

  it("let OTIS_HOME hold everything in one place", () => {
    process.env.OTIS_HOME = "/tmp/otis-home"
    expect(localConfigDirectory()).toBe(resolve("/tmp/otis-home"))
    expect(localDataDirectory()).toBe(resolve("/tmp/otis-home"))
  })
})

describe("tarExecutable", () => {
  it("names Windows' own bsdtar there and the system tar elsewhere", () => {
    expect(tarExecutable()).toBe(
      windows ? join(process.env.SystemRoot ?? "", "System32", "tar.exe") : "tar",
    )
    if (windows) expect(existsSync(tarExecutable())).toBe(true)
  })
})

describe("extractZip", () => {
  it("unpacks nested files into a folder named outside the system code page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otis-zip-"))
    try {
      const zip = new JSZip()
      zip.file("llama-server.exe", "server")
      zip.file("lib/ggml.dll", "ggml")
      zip.folder("empty")
      writeFileSync(join(directory, "runtime.zip"), await zip.generateAsync({ type: "nodebuffer" }))
      const destination = join(directory, "Никита", "日本語")
      expect(await extractZip(join(directory, "runtime.zip"), destination)).toEqual([
        "llama-server.exe",
        "lib/ggml.dll",
      ])
      expect(readFileSync(join(destination, "llama-server.exe"), "utf8")).toBe("server")
      expect(readFileSync(join(destination, "lib", "ggml.dll"), "utf8")).toBe("ggml")
      expect(existsSync(join(destination, "empty"))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses an entry that would land outside the destination", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otis-zip-"))
    try {
      const zip = new JSZip()
      zip.file("../escape.txt", "outside")
      writeFileSync(join(directory, "bad.zip"), await zip.generateAsync({ type: "nodebuffer" }))
      await expect(extractZip(join(directory, "bad.zip"), join(directory, "out"))).rejects.toThrow()
      expect(existsSync(join(directory, "escape.txt"))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("findOnPath", () => {
  it("returns the first PATH directory holding the name, or nothing", () => {
    const directory = mkdtempSync(join(tmpdir(), "otis-path-"))
    try {
      writeFileSync(join(directory, "otis-probe.exe"), "")
      const env = { PATH: ["/nowhere", directory].join(delimiter) }
      expect(findOnPath("otis-probe.exe", env)).toBe(join(directory, "otis-probe.exe"))
      expect(findOnPath("absent.exe", env)).toBeUndefined()
      expect(findOnPath("otis-probe.exe", { PATH: "" })).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("shellCommand", () => {
  it.skipIf(windows)("runs the login shell, defaulting to sh", () => {
    expect(shellCommand({ SHELL: "/bin/zsh" })).toEqual({ command: "/bin/zsh", args: ["-lc"] })
    expect(shellCommand({})).toEqual({ command: "/bin/sh", args: ["-lc"] })
  })

  it.skipIf(!windows)("runs Git for Windows' bash", () => {
    const shell = shellCommand()
    expect(basename(shell.command)).toBe("bash.exe")
    expect(shell.command.toLowerCase()).not.toContain("\\system32\\")
    expect(existsSync(shell.command)).toBe(true)
    expect(shell.args).toEqual(["-lc"])
  })
})

describe("terminateProcessTree", () => {
  it("ends the command and the processes it started", async () => {
    const shell = shellCommand()
    // The shell starts a Bun grandchild and reports its pid, then both idle until ended.
    const script =
      `${JSON.stringify(process.execPath)} -e '` +
      'const { spawn } = require("node:child_process"); ' +
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); ' +
      "console.log(child.pid); setInterval(() => {}, 1000)" +
      "'"
    const child = spawn(shell.command, [...shell.args, script], {
      detached: !windows,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const grandchild = Number(
      await new Promise<string>((resolve) =>
        child.stdout.once("data", (chunk) => resolve(String(chunk))),
      ),
    )
    expect(grandchild).toBeGreaterThan(0)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(grandchild)).toBe(true)
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    terminateProcessTree(child, "SIGTERM")
    await closed
    for (let attempt = 0; attempt < 100 && alive(grandchild); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alive(grandchild)).toBe(false)
  })
})
