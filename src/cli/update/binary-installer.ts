import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type ReleaseArtifact, resolveArtifactURL } from "./manifest.js"

type InstallOptions = {
  artifact: ReleaseArtifact
  baseURL: string
  execPath: string
  fetch: typeof fetch
  target: string
  tmpDir?: string
}

export async function installReleaseArtifact(options: InstallOptions) {
  const workDirectory = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "otis-update-"))
  try {
    const archiveURL = resolveArtifactURL(options.baseURL, options.artifact)
    const archiveName = path.basename(new URL(archiveURL).pathname) || `${options.target}.tar.gz`
    const archivePath = path.join(workDirectory, archiveName)
    const extractDirectory = path.join(workDirectory, "extract")

    await downloadFile(archiveURL, archivePath, options.fetch)
    if (options.artifact.size !== undefined && (await fs.stat(archivePath)).size !== options.artifact.size) {
      throw new Error("Downloaded Otis archive size did not match the release manifest.")
    }
    if ((await sha256File(archivePath)) !== options.artifact.sha256) {
      throw new Error("Downloaded Otis archive failed checksum verification.")
    }

    await extractTarGz(archivePath, extractDirectory)
    const updateTarget = await resolveUpdateTarget(options.execPath)
    await replaceBinary(path.join(extractDirectory, "otis"), updateTarget)
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true })
  }
}

export function detectTarget() {
  const platform = process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined
  const architecture = process.arch === "arm64" || process.arch === "x64" ? process.arch : undefined
  if (!platform || !architecture) throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`)
  return `${platform}-${architecture}`
}

async function downloadFile(url: string, destination: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  if (!response.body) throw new Error(`Failed to download ${url}: response body was empty`)

  const file = await fs.open(destination, "w")
  try {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await file.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    await fs.rm(destination, { force: true })
    throw error
  } finally {
    await file.close()
  }
}

async function resolveUpdateTarget(execPath: string) {
  const target = cleanEnv(process.env.OTIS_UPDATE_TARGET) ?? execPath
  try {
    return await fs.realpath(target)
  } catch {
    return target
  }
}

async function replaceBinary(sourcePath: string, targetPath: string) {
  const temporaryPath = path.join(path.dirname(targetPath), `.otis-update-${process.pid}-${Date.now()}`)
  try {
    await fs.copyFile(sourcePath, temporaryPath)
    await fs.chmod(temporaryPath, 0o755)
    await fs.rename(temporaryPath, targetPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    if (isPermissionError(error)) {
      throw new Error(
        `Cannot write ${targetPath}. Reinstall Otis into a user-writable directory or rerun the update with permission to write there.`,
      )
    }
    throw error
  }
}

async function extractTarGz(archivePath: string, destination: string) {
  const entries = (await runCommand("tar", ["-tzf", archivePath]))
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length !== 1 || (entries[0] !== "otis" && entries[0] !== "./otis")) {
    throw new Error("Otis release archive must contain only the otis binary.")
  }

  await fs.mkdir(destination, { recursive: true })
  await runCommand("tar", ["-xzf", archivePath, "-C", destination])
  if (!(await fs.lstat(path.join(destination, "otis"))).isFile()) {
    throw new Error("Otis release archive did not contain a regular binary.")
  }
}

function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })
}

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256")
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

function cleanEnv(value: string | undefined) {
  return value?.trim() || undefined
}

function isPermissionError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  )
}
