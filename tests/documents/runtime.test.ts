import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DocumentProcessRunner } from "../../src/documents/process.js"
import { checkDocumentRuntime, ensureDocumentRuntime } from "../../src/documents/runtime.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "otis-document-runtime-"))
  directories.push(dataDirectory)
  const requirements = join(dataDirectory, "requirements.txt")
  await writeFile(requirements, "fixture")
  let installed = false
  let installError = false
  let healthy = true
  let pythonAvailable = true
  let onInstall = async () => {}
  const run = vi.fn<DocumentProcessRunner>(async (command, args, options) => {
    options.signal?.throwIfAborted()
    if (args.includes("venv")) {
      const env = args.at(-1) as string
      const binary = join(env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
      await mkdir(dirname(binary), { recursive: true })
      await writeFile(binary, "fixture interpreter")
      installed = false
      return ""
    }
    if (args.includes("install")) {
      await onInstall()
      options.signal?.throwIfAborted()
      if (installError) throw new Error("Package download unavailable")
      installed = true
      return "Installed"
    }
    if (args.includes("check")) return "No broken requirements"
    if (args.includes("-c")) {
      if (command.includes("document-runtime")) {
        if (!installed) throw new Error("No interpreter")
        return JSON.stringify({
          python: command,
          version: [3, 12, 8],
          missing: healthy ? [] : ["pypdf"],
          libreoffice: false,
        })
      }
      if (command !== "python3" || !pythonAvailable) throw new Error("Python unavailable")
      return JSON.stringify({
        python: "/test/python3",
        version: [3, 12, 8],
        missing: ["pypdf"],
        libreoffice: false,
      })
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`)
  })
  return {
    dataDirectory,
    requirements,
    run,
    failInstall: (value: boolean) => {
      installError = value
    },
    breakEnvironment: () => {
      healthy = false
    },
    noPython: () => {
      pythonAvailable = false
    },
    duringInstall: (fn: () => Promise<void>) => {
      onInstall = fn
    },
  }
}

describe("document runtime", () => {
  it("checks readiness without creating a runtime or installing packages", async () => {
    const fixture = await setup()
    expect(await checkDocumentRuntime(fixture, fixture.run)).toMatchObject({
      ready: false,
      python_version: "3.12.8",
      libreoffice: false,
    })
    expect(await readdir(fixture.dataDirectory)).toEqual(["requirements.txt"])
    expect(fixture.run.mock.calls.every(([, args]) => args.includes("-c"))).toBe(true)
    fixture.noPython()
    expect(await checkDocumentRuntime(fixture, fixture.run)).toMatchObject({
      ready: false,
      python: null,
      reason: expect.stringContaining("Python 3.10"),
    })
  })

  it("prepares once, verifies installed packages and shares the environment across concurrent callers", async () => {
    const fixture = await setup()
    fixture.duringInstall(() => delay(40))
    const values = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureDocumentRuntime(fixture, fixture.requirements, fixture.run),
      ),
    )
    expect(new Set(values).size).toBe(1)
    const installations = fixture.run.mock.calls.filter(([, args]) => args.includes("install"))
    expect(installations).toHaveLength(1)
    expect(installations[0][1]).toEqual(
      expect.arrayContaining([
        "--only-binary=:all:",
        "--no-deps",
        "https://pypi.org/simple",
        "-r",
        fixture.requirements,
      ]),
    )
    expect(fixture.run.mock.calls.some(([, args]) => args.includes("check"))).toBe(true)
    expect(await checkDocumentRuntime(fixture, fixture.run)).toMatchObject({
      ready: true,
      missing_packages: [],
    })
    expect(await readFile(values[0], "utf8")).toBe("fixture interpreter")
    expect(await readdir(join(fixture.dataDirectory, "document-runtime"))).toHaveLength(1)
    if (process.platform !== "win32")
      expect((await stat(join(fixture.dataDirectory, "document-runtime"))).mode & 0o777).toBe(0o700)
  })

  it("removes partial installs and retries cleanly after a download failure", async () => {
    const fixture = await setup()
    fixture.failInstall(true)
    await expect(ensureDocumentRuntime(fixture, fixture.requirements, fixture.run)).rejects.toThrow(
      "Package download unavailable",
    )
    expect(await readdir(join(fixture.dataDirectory, "document-runtime"))).toEqual([])
    fixture.failInstall(false)
    await expect(
      ensureDocumentRuntime(fixture, fixture.requirements, fixture.run),
    ).resolves.toContain("document-runtime")
  })

  it("does not report a broken installation as ready", async () => {
    const fixture = await setup()
    fixture.breakEnvironment()
    await expect(ensureDocumentRuntime(fixture, fixture.requirements, fixture.run)).rejects.toThrow(
      "failed verification",
    )
    expect(await readdir(join(fixture.dataDirectory, "document-runtime"))).toEqual([])
  })

  it("recovers an abandoned setup lock and refuses symlinked runtime paths", async () => {
    const fixture = await setup()
    const root = join(fixture.dataDirectory, "document-runtime")
    await mkdir(root)
    await writeFile(join(root, "setup.lock"), JSON.stringify({ pid: 999999, token: "dead" }))
    const python = await ensureDocumentRuntime(fixture, fixture.requirements, fixture.run)
    const env = dirname(dirname(python))
    await rm(env, { recursive: true })
    const outside = join(fixture.dataDirectory, "outside")
    await mkdir(outside)
    await symlink(outside, env)
    await expect(ensureDocumentRuntime(fixture, fixture.requirements, fixture.run)).rejects.toThrow(
      "symlink",
    )
    await expect(checkDocumentRuntime(fixture, fixture.run)).rejects.toThrow("symlink")
    expect(await readdir(outside)).toEqual([])
  })

  it("cancels a waiting caller without removing another caller's lock", async () => {
    const fixture = await setup()
    const root = join(fixture.dataDirectory, "document-runtime")
    await mkdir(root)
    const lock = JSON.stringify({ pid: process.pid, token: "owner" })
    await writeFile(join(root, "setup.lock"), lock)
    const controller = new AbortController()
    const pending = ensureDocumentRuntime(
      { ...fixture, signal: controller.signal },
      fixture.requirements,
      fixture.run,
    )
    const assertion = expect(pending).rejects.toThrow()
    await delay(20)
    controller.abort()
    await assertion
    expect(await readFile(join(root, "setup.lock"), "utf8")).toBe(lock)
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it("cleans an interrupted installation and reports missing Python clearly", async () => {
    const fixture = await setup()
    const controller = new AbortController()
    fixture.duringInstall(async () => {
      controller.abort()
    })
    await expect(
      ensureDocumentRuntime(
        { ...fixture, signal: controller.signal },
        fixture.requirements,
        fixture.run,
      ),
    ).rejects.toThrow()
    expect(await readdir(join(fixture.dataDirectory, "document-runtime"))).toEqual([])
    fixture.noPython()
    await expect(ensureDocumentRuntime(fixture, fixture.requirements, fixture.run)).rejects.toThrow(
      "Python 3.10",
    )
  })
})
