import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_RELEASES_BASE_URL = "https://github.com/triangllabs/otis/releases"
const CURRENT_VERSION = process.env.OTIS_VERSION ?? "dev"
const UPDATE_HELP =
  "Usage: otis update [--version VERSION] [--base-url URL]\n\nUpdates the installed Otis binary from GitHub Releases.\n"

type ReleaseArtifact = { path: string; sha256: string; size?: number }

type RunUpdateOptions = {
  baseURL?: string
  currentVersion?: string
  execPath?: string
  fetch?: typeof fetch
  stdout?: { write(chunk: string): unknown }
  target?: string
  tmpDir?: string
}

type CheckForUpdateOptions = {
  baseURL?: string
  currentVersion?: string
  fetch?: typeof fetch
  signal?: AbortSignal
}

export async function checkForUpdate(
  options: CheckForUpdateOptions = {},
): Promise<{ available: boolean; version: string } | null> {
  const currentVersion = normalizeVersion(options.currentVersion ?? CURRENT_VERSION)
  if (currentVersion === "dev") return null

  const manifestURL = `${releasesBaseURL(options.baseURL)}/latest/download/manifest.json`
  const manifest = await fetchReleaseManifest(manifestURL, options.fetch ?? fetch, options.signal)
  const releaseVersion = normalizeVersion(manifest.version)
  validateVersion("Release version", releaseVersion)
  return { available: compareVersions(currentVersion, releaseVersion) < 0, version: releaseVersion }
}

export async function runUpdateCommand(args: string[] = [], options: RunUpdateOptions = {}) {
  const stdout = options.stdout ?? process.stdout
  let help = false
  let version: string | undefined
  let baseURLArgument: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
      help = true
    } else if (argument === "--version" || argument === "--base-url") {
      const value = args[index + 1]
      if (!value) throw new Error(`Missing value for ${argument}.`)
      if (argument === "--version") version = value
      else baseURLArgument = value
      index += 1
    } else if (argument.startsWith("--version=")) {
      version = argument.slice("--version=".length)
    } else if (argument.startsWith("--base-url=")) {
      baseURLArgument = argument.slice("--base-url=".length)
    } else {
      throw new Error(`Unknown update option: ${argument}`)
    }
  }
  if (help) {
    stdout.write(UPDATE_HELP)
    return
  }

  const currentVersion = normalizeVersion(options.currentVersion ?? CURRENT_VERSION)
  if (currentVersion === "dev" && !options.execPath && !cleanEnv(process.env.OTIS_UPDATE_TARGET)) {
    throw new Error("Cannot update a development build. Install Otis with curl first.")
  }

  const baseURL = releasesBaseURL(baseURLArgument ?? options.baseURL)
  const fetchImpl = options.fetch ?? fetch
  let target = options.target
  if (!target) {
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined
    const architecture =
      process.arch === "arm64" || process.arch === "x64" ? process.arch : undefined
    if (!platform || !architecture)
      throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`)
    target = `${platform}-${architecture}`
  }
  const requestedVersion = version ? normalizeVersion(version) : undefined
  if (requestedVersion) validateVersion("Requested version", requestedVersion)
  const manifestURL = requestedVersion
    ? `${baseURL}/download/v${requestedVersion}/manifest.json`
    : `${baseURL}/latest/download/manifest.json`

  stdout.write("Checking for Otis updates...\n")
  const manifest = await fetchReleaseManifest(manifestURL, fetchImpl)
  const releaseVersion = normalizeVersion(manifest.version)
  validateVersion("Release version", releaseVersion)

  if (
    !requestedVersion &&
    currentVersion !== "dev" &&
    compareVersions(currentVersion, releaseVersion) >= 0
  ) {
    stdout.write(`Otis is already up to date (v${currentVersion}).\n`)
    return
  }

  const artifact = manifest.artifacts[target]
  if (!artifact) throw new Error(`No Otis release artifact is available for ${target}.`)

  stdout.write(`Downloading Otis v${releaseVersion} for ${target}...\n`)
  const assetsBase = new URL(
    `${requestedVersion ? `${baseURL}/download/v${releaseVersion}` : `${baseURL}/latest/download`}/`,
  )
  if (artifact.path.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(artifact.path)) {
    throw new Error("Release artifact path must be relative.")
  }
  const resolved = new URL(artifact.path.replace(/^\/+/, ""), assetsBase)
  if (
    resolved.protocol !== assetsBase.protocol ||
    resolved.host !== assetsBase.host ||
    !resolved.pathname.startsWith(assetsBase.pathname)
  ) {
    throw new Error(`Release artifact URL must stay under ${assetsBase.toString()}`)
  }
  const archiveURL = resolved.toString()

  const workDirectory = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "otis-update-"))
  try {
    const archivePath = path.join(
      workDirectory,
      path.basename(resolved.pathname) || `${target}.tar.gz`,
    )
    const extractDirectory = path.join(workDirectory, "extract")

    const response = await fetchImpl(archiveURL)
    if (!response.ok) throw new Error(`Failed to download ${archiveURL}: HTTP ${response.status}`)
    if (!response.body) throw new Error(`Failed to download ${archiveURL}: response body was empty`)
    const file = await fs.open(archivePath, "w")
    try {
      for await (const chunk of response.body) await file.write(chunk)
    } finally {
      await file.close()
    }
    if (artifact.size !== undefined && (await fs.stat(archivePath)).size !== artifact.size) {
      throw new Error("Downloaded Otis archive size did not match the release manifest.")
    }
    const hash = crypto.createHash("sha256")
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk)
    if (hash.digest("hex") !== artifact.sha256) {
      throw new Error("Downloaded Otis archive failed checksum verification.")
    }

    const entries = (await runCommand("tar", ["-tzf", archivePath]))
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (entries.length !== 1 || (entries[0] !== "otis" && entries[0] !== "./otis")) {
      throw new Error("Otis release archive must contain only the otis binary.")
    }
    await fs.mkdir(extractDirectory, { recursive: true })
    await runCommand("tar", ["-xzf", archivePath, "-C", extractDirectory])
    const binaryPath = path.join(extractDirectory, "otis")
    if (!(await fs.lstat(binaryPath)).isFile()) {
      throw new Error("Otis release archive did not contain a regular binary.")
    }

    const updateTarget =
      cleanEnv(process.env.OTIS_UPDATE_TARGET) ?? options.execPath ?? process.execPath
    const targetPath = await fs.realpath(updateTarget).catch(() => updateTarget)
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.otis-update-${process.pid}-${Date.now()}`,
    )
    try {
      await fs.copyFile(binaryPath, temporaryPath)
      await fs.chmod(temporaryPath, 0o755)
      await fs.rename(temporaryPath, targetPath)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      const code = (error as { code?: unknown } | null)?.code
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Cannot write ${targetPath}. Reinstall Otis into a user-writable directory or rerun the update with permission to write there.`,
        )
      }
      throw error
    }
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true })
  }
  stdout.write(`Otis updated to v${releaseVersion}.\n`)
}

function releasesBaseURL(value?: string) {
  const trimmed = (
    value ??
    cleanEnv(process.env.OTIS_RELEASES_BASE_URL) ??
    DEFAULT_RELEASES_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "")
  if (!trimmed) throw new Error("Download base URL cannot be blank.")
  return trimmed
}

function cleanEnv(value: string | undefined) {
  return value?.trim() || undefined
}

async function fetchReleaseManifest(url: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const response = await fetchImpl(url, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error("Release manifest is invalid.")
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Release manifest is missing a version.")
  }
  if (!isRecord(value.artifacts)) throw new Error("Release manifest is missing artifacts.")

  const artifacts: Record<string, ReleaseArtifact> = {}
  for (const [target, entry] of Object.entries(value.artifacts)) {
    if (!isRecord(entry)) throw new Error(`Release artifact for ${target} is invalid.`)
    const path = nonEmptyString(entry.path)
    const sha256 = nonEmptyString(entry.sha256)
    const size = entry.size
    if (!path) throw new Error(`Release artifact for ${target} is missing a path.`)
    if (!sha256) throw new Error(`Release artifact for ${target} is missing a checksum.`)
    if (!/^[a-f\d]{64}$/i.test(sha256))
      throw new Error(`Release artifact for ${target} has an invalid checksum.`)
    if (
      size !== undefined &&
      !(typeof size === "number" && Number.isSafeInteger(size) && size > 0)
    ) {
      throw new Error(`Release artifact for ${target} has an invalid size.`)
    }
    artifacts[target] = { path, sha256, size }
  }
  return { version: value.version, artifacts }
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/, "")
}

function validateVersion(label: string, version: string) {
  if (!parseVersionParts(version)) throw new Error(`${label} is not valid semver: ${version}`)
}

function parseVersionParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compareVersions(left: string, right: string) {
  if (left === right) return 0
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  if (!leftParts) throw new Error(`Current version is not valid semver: ${left}`)
  if (!rightParts) throw new Error(`Release version is not valid semver: ${right}`)

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }

  const leftPrerelease = parsePrerelease(left)
  const rightPrerelease = parsePrerelease(right)
  if (!leftPrerelease && !rightPrerelease) return 0
  if (!leftPrerelease) return 1
  if (!rightPrerelease) return -1

  const length = Math.max(leftPrerelease.length, rightPrerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index]
    const rightIdentifier = rightPrerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : undefined
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : undefined
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier > rightIdentifier ? 1 : -1
    }
  }
  return 0
}

function parsePrerelease(version: string) {
  return /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version)?.[4]?.split(".")
}
