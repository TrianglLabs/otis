import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const script = join(import.meta.dirname, "../../scripts/install.sh")
const arch = process.arch === "arm64" ? "arm64" : "x64"
const os = process.platform === "darwin" ? "darwin" : "linux"
const artifact = `otis-${os}-${arch}.tar.gz`

let releases: string
let baseUrl: string
const server = createServer((request, response) => {
  const file = request.url?.startsWith("/latest/download/latest.txt")
    ? "latest.txt"
    : request.url?.startsWith("/download/v0.0.1/")
      ? request.url.slice("/download/v0.0.1/".length)
      : undefined
  try {
    if (!file) throw new Error("not found")
    response.end(readFileSync(join(releases, file)))
  } catch {
    response.statusCode = 404
    response.end()
  }
})

beforeAll(async () => {
  releases = mkdtempSync(join(tmpdir(), "otis-releases-"))
  writeFileSync(join(releases, "otis"), "#!/bin/sh\necho otis 0.0.1\n", { mode: 0o755 })
  spawnSync("tar", ["-czf", join(releases, artifact), "-C", releases, "otis"])
  const digest = createHash("sha256")
    .update(readFileSync(join(releases, artifact)))
    .digest("hex")
  writeFileSync(join(releases, "checksums.txt"), `${digest}  ${artifact}\n`)
  writeFileSync(join(releases, "latest.txt"), "v0.0.1\n")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no server address")
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server.close()
  rmSync(releases, { recursive: true, force: true })
})

// The release server answers on this worker's event loop, so the script must run asynchronously.
function install(installDir: string) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn("bash", [script, "--base-url", baseUrl, "--install-dir", installDir])
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("close", (status) => resolve({ status, stderr }))
  })
}

describe("install.sh", () => {
  it("installs the verified terminal binary", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      const result = await install(installDir)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(installDir, "otis"), "utf8")).toContain("otis 0.0.1")
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })

  it("refuses to overwrite the desktop AppImage installed under the same name", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      // ELF header with the AppImage type-2 magic at offset 8.
      const appImage = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
        Buffer.from("AI\u0002"),
        Buffer.alloc(64),
      ])
      writeFileSync(join(installDir, "otis"), appImage, { mode: 0o755 })
      const result = await install(installDir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("is the Otis desktop AppImage")
      expect(result.stderr).toContain(`${installDir}/otis-desktop`)
      expect(readFileSync(join(installDir, "otis"))).toEqual(appImage)
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })
})
