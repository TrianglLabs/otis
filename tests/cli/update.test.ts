import { execFile } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkForUpdate, runUpdateCommand } from "../../src/cli/update.js"

const execFileAsync = promisify(execFile)
const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((tmpDir) => fs.rm(tmpDir, { recursive: true, force: true })))
})

describe("runUpdateCommand", () => {
  it("does not download an artifact when Otis is already current", async () => {
    const output = createOutput()
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.1.2", artifacts: {} }))

    await runUpdateCommand([], {
      currentVersion: "0.1.2",
      execPath: "/tmp/otis",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: output,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(output.text()).toContain("Otis is already up to date (v0.1.2).")
  })

  it("replaces the installed binary with a verified release artifact", async () => {
    const tmpDir = await makeTmpDir()
    const installDir = path.join(tmpDir, "install")
    const installedBinary = path.join(installDir, "otis")
    await fs.mkdir(installDir, { recursive: true })
    await fs.writeFile(installedBinary, "old")
    await fs.chmod(installedBinary, 0o755)

    const archivePath = await makeArchive(tmpDir, "new")
    const archive = await fs.readFile(archivePath)
    const sha256 = await sha256File(archivePath)
    const archiveResponse = new Response(new Uint8Array(archive))
    const arrayBufferSpy = vi.spyOn(archiveResponse, "arrayBuffer")
    const output = createOutput()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/latest/download/manifest.json")) {
        return jsonResponse({
          version: "0.1.3",
          artifacts: {
            "darwin-arm64": {
              path: "otis-darwin-arm64.tar.gz",
              sha256,
            },
          },
        })
      }
      if (url.endsWith("/latest/download/otis-darwin-arm64.tar.gz")) {
        return archiveResponse
      }
      return new Response("not found", { status: 404 })
    })

    await runUpdateCommand([], {
      baseURL: "https://example.com/otis",
      currentVersion: "0.1.2",
      execPath: installedBinary,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: output,
      target: "darwin-arm64",
      tmpDir,
    })

    expect(await fs.readFile(installedBinary, "utf8")).toBe("new")
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(output.text()).toContain("Otis updated to v0.1.3.")
  })

  it("rejects release artifact paths outside the GitHub release", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        version: "0.1.3",
        artifacts: {
          "darwin-arm64": {
            path: "../../../../evil/otis-darwin-arm64.tar.gz",
            sha256: "0".repeat(64),
          },
        },
      }),
    )

    await expect(
      runUpdateCommand([], {
        baseURL: "https://example.com/otis",
        currentVersion: "0.1.2",
        execPath: "/tmp/otis",
        fetch: fetchMock as unknown as typeof fetch,
        stdout: createOutput(),
        target: "darwin-arm64",
      }),
    ).rejects.toThrow("Release artifact URL must stay under https://example.com/otis/latest/download/")

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("rejects invalid release versions before downloading artifacts", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "nightly", artifacts: {} }))

    await expect(
      runUpdateCommand([], {
        baseURL: "https://example.com/otis",
        currentVersion: "0.1.2",
        execPath: "/tmp/otis",
        fetch: fetchMock as unknown as typeof fetch,
        stdout: createOutput(),
        target: "darwin-arm64",
      }),
    ).rejects.toThrow("Release version is not valid semver: nightly")

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("rejects malformed release checksums and sizes", async () => {
    const malformedChecksum = vi.fn(async () =>
      jsonResponse({
        version: "0.1.3",
        artifacts: { "darwin-arm64": { path: "otis.tar.gz", sha256: "not-a-hash" } },
      }),
    )
    await expect(
      runUpdateCommand([], {
        currentVersion: "0.1.2",
        execPath: "/tmp/otis",
        fetch: malformedChecksum as unknown as typeof fetch,
        stdout: createOutput(),
        target: "darwin-arm64",
      }),
    ).rejects.toThrow("invalid checksum")

    const malformedSize = vi.fn(async () =>
      jsonResponse({
        version: "0.1.3",
        artifacts: { "darwin-arm64": { path: "otis.tar.gz", sha256: "0".repeat(64), size: -1 } },
      }),
    )
    await expect(
      runUpdateCommand([], {
        currentVersion: "0.1.2",
        execPath: "/tmp/otis",
        fetch: malformedSize as unknown as typeof fetch,
        stdout: createOutput(),
        target: "darwin-arm64",
      }),
    ).rejects.toThrow("invalid size")
  })

  it("rejects an archive whose otis entry is a symlink", async () => {
    const tmpDir = await makeTmpDir()
    const installDir = path.join(tmpDir, "install")
    const installedBinary = path.join(installDir, "otis")
    await fs.mkdir(installDir, { recursive: true })
    await fs.writeFile(installedBinary, "old")

    const sourceDir = path.join(tmpDir, "symlink-source")
    const archivePath = path.join(tmpDir, "symlink.tar.gz")
    await fs.mkdir(sourceDir)
    await fs.symlink("target", path.join(sourceDir, "otis"))
    await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "otis"])
    const archive = await fs.readFile(archivePath)
    const sha256 = await sha256File(archivePath)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/latest/download/manifest.json")) {
        return jsonResponse({
          version: "0.1.3",
          artifacts: {
            "darwin-arm64": { path: "otis-darwin-arm64.tar.gz", sha256 },
          },
        })
      }
      return new Response(new Uint8Array(archive))
    })

    await expect(
      runUpdateCommand([], {
        baseURL: "https://example.com/otis",
        currentVersion: "0.1.2",
        execPath: installedBinary,
        fetch: fetchMock as unknown as typeof fetch,
        stdout: createOutput(),
        target: "darwin-arm64",
        tmpDir,
      }),
    ).rejects.toThrow("did not contain a regular binary")
    await expect(fs.readFile(installedBinary, "utf8")).resolves.toBe("old")
  })
})

describe("checkForUpdate", () => {
  it("returns available when the latest version is newer", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.1.3", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.1.2",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: true, version: "0.1.3" })
  })

  it("returns not available when already up to date", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.1.2", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.1.2",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: false, version: "0.1.2" })
  })

  it("returns not available when current is newer than latest", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.1.1", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.1.2",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: false, version: "0.1.1" })
  })

  it("returns null for dev builds without fetching", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.1.3", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "dev",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws on an invalid release version", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "nightly", artifacts: {} }))

    await expect(
      checkForUpdate({
        currentVersion: "0.1.2",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Release version is not valid semver: nightly")
  })

  it("passes the abort signal to fetch", async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse({ version: "0.1.3", artifacts: {} })
    })

    await checkForUpdate({
      currentVersion: "0.1.2",
      fetch: fetchMock as unknown as typeof fetch,
      signal: controller.signal,
    })

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }))
  })

  it("reports an update for a prerelease current version against a stable release", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-rc.1",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: true, version: "0.2.0" })
  })

  it("does not report an update when both versions are the same prerelease", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0-rc.1", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-rc.1",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: false, version: "0.2.0-rc.1" })
  })

  it("reports an update for an older prerelease against a newer prerelease", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0-rc.2", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-rc.1",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: true, version: "0.2.0-rc.2" })
  })

  it("does not report an update for a newer prerelease against an older prerelease", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0-rc.1", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-rc.2",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: false, version: "0.2.0-rc.1" })
  })

  it("compares alphanumeric prerelease identifiers lexically", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0-rc.1", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-alpha.1",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: true, version: "0.2.0-rc.1" })
  })

  it("compares numeric prerelease identifiers numerically", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "0.2.0-2", artifacts: {} }))

    const result = await checkForUpdate({
      currentVersion: "0.2.0-10",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ available: false, version: "0.2.0-2" })
  })
})

async function makeTmpDir() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "otis-update-test-"))
  tmpDirs.push(tmpDir)
  return tmpDir
}

async function makeArchive(tmpDir: string, contents: string) {
  const sourceDir = path.join(tmpDir, "archive-source")
  const archivePath = path.join(tmpDir, "otis-darwin-arm64.tar.gz")
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.writeFile(path.join(sourceDir, "otis"), contents)
  await fs.chmod(path.join(sourceDir, "otis"), 0o755)
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "otis"])
  return archivePath
}

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256")
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}

function createOutput() {
  let value = ""
  return {
    write(chunk: string) {
      value += chunk
    },
    text() {
      return value
    },
  }
}
