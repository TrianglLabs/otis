import { detectTarget, installReleaseArtifact } from "./update/binary-installer.js"
import { fetchReleaseManifest, normalizeBaseURL } from "./update/manifest.js"
import { compareVersions, normalizeVersion, validateVersion } from "./update/version.js"

const DEFAULT_RELEASES_BASE_URL = "https://github.com/triangllabs/otis/releases"
const CURRENT_VERSION = process.env.OTIS_VERSION ?? "dev"

type Writable = {
  write(chunk: string): unknown
}

type UpdateArgs = {
  baseURL?: string
  help: boolean
  version?: string
}

export type RunUpdateOptions = {
  baseURL?: string
  currentVersion?: string
  execPath?: string
  fetch?: typeof fetch
  stdout?: Writable
  target?: string
  tmpDir?: string
}

export type UpdateCheckResult = {
  available: boolean
  version: string
}

export type CheckForUpdateOptions = {
  baseURL?: string
  currentVersion?: string
  fetch?: typeof fetch
  signal?: AbortSignal
}

export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateCheckResult | null> {
  const currentVersion = normalizeVersion(options.currentVersion ?? CURRENT_VERSION)
  if (currentVersion === "dev") return null

  const baseURL = releasesBaseURL(options.baseURL)
  const manifest = await fetchReleaseManifest(latestManifestURL(baseURL), options.fetch ?? fetch, options.signal)
  const releaseVersion = normalizeVersion(manifest.version)
  validateVersion("Release version", releaseVersion)
  return { available: compareVersions(currentVersion, releaseVersion) < 0, version: releaseVersion }
}

export async function runUpdateCommand(args: string[] = [], options: RunUpdateOptions = {}) {
  const parsedArgs = parseUpdateArgs(args)
  const stdout = options.stdout ?? process.stdout
  if (parsedArgs.help) {
    stdout.write(updateHelp())
    return
  }

  const currentVersion = normalizeVersion(options.currentVersion ?? CURRENT_VERSION)
  if (currentVersion === "dev" && !options.execPath && !cleanEnv(process.env.OTIS_UPDATE_TARGET)) {
    throw new Error("Cannot update a development build. Install Otis with curl first.")
  }

  const baseURL = releasesBaseURL(parsedArgs.baseURL ?? options.baseURL)
  const target = options.target ?? detectTarget()
  const requestedVersion = parsedArgs.version ? normalizeVersion(parsedArgs.version) : undefined
  if (requestedVersion) validateVersion("Requested version", requestedVersion)
  const manifestURL = requestedVersion ? versionManifestURL(baseURL, requestedVersion) : latestManifestURL(baseURL)

  stdout.write("Checking for Otis updates...\n")
  const manifest = await fetchReleaseManifest(manifestURL, options.fetch ?? fetch)
  const releaseVersion = normalizeVersion(manifest.version)
  validateVersion("Release version", releaseVersion)

  if (!requestedVersion && currentVersion !== "dev" && compareVersions(currentVersion, releaseVersion) >= 0) {
    stdout.write(`Otis is already up to date (v${currentVersion}).\n`)
    return
  }

  const artifact = manifest.artifacts[target]
  if (!artifact) throw new Error(`No Otis release artifact is available for ${target}.`)

  stdout.write(`Downloading Otis v${releaseVersion} for ${target}...\n`)
  await installReleaseArtifact({
    artifact,
    baseURL: requestedVersion ? versionAssetsURL(baseURL, releaseVersion) : `${baseURL}/latest/download`,
    execPath: options.execPath ?? process.execPath,
    fetch: options.fetch ?? fetch,
    target,
    tmpDir: options.tmpDir,
  })
  stdout.write(`Otis updated to v${releaseVersion}.\n`)
}

function parseUpdateArgs(args: string[]): UpdateArgs {
  const parsed: UpdateArgs = { help: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
      parsed.help = true
    } else if (argument === "--version" || argument === "--base-url") {
      const value = args[index + 1]
      if (!value) throw new Error(`Missing value for ${argument}.`)
      if (argument === "--version") parsed.version = value
      else parsed.baseURL = value
      index += 1
    } else if (argument.startsWith("--version=")) {
      parsed.version = argument.slice("--version=".length)
    } else if (argument.startsWith("--base-url=")) {
      parsed.baseURL = argument.slice("--base-url=".length)
    } else {
      throw new Error(`Unknown update option: ${argument}`)
    }
  }
  return parsed
}

function releasesBaseURL(value?: string) {
  return normalizeBaseURL(value ?? cleanEnv(process.env.OTIS_RELEASES_BASE_URL) ?? DEFAULT_RELEASES_BASE_URL)
}

function updateHelp() {
  return "Usage: otis update [--version VERSION] [--base-url URL]\n\nUpdates the installed Otis binary from GitHub Releases.\n"
}

function latestManifestURL(baseURL: string) {
  return `${baseURL}/latest/download/manifest.json`
}

function versionManifestURL(baseURL: string, version: string) {
  return `${versionAssetsURL(baseURL, version)}/manifest.json`
}

function versionAssetsURL(baseURL: string, version: string) {
  return `${baseURL}/download/v${version}`
}

function cleanEnv(value: string | undefined) {
  return value?.trim() || undefined
}
