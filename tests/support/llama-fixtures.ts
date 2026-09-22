import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, stat, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { detectHardware, type HardwareProbe } from "../../src/inference/hardware.js"
import {
  llamaRuntimeReleaseTag,
  llamaRuntimeTarget,
  pinnedLlamaCppAsset,
} from "../../src/inference/llama-binary.js"
import {
  LOCAL_MODELS,
  type LocalModelSpec,
  localModelWeightBytes,
} from "../../src/inference/local-catalog.js"
import { fitLocalModel } from "../../src/inference/local-fit.js"

const execFileAsync = promisify(execFile)

/** Opt-in switch for suites that boot the real llama-server on this machine. */
export const OTIS_INTEGRATION = process.env.OTIS_INTEGRATION === "1"

/** Environment the integration suites hand to the application and to llama-server. */
export const INTEGRATION_ENV: NodeJS.ProcessEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
}

export type CachedLocalModel = {
  /** The packing the runtime would select for this hardware, as cached on disk. */
  spec: LocalModelSpec
  /** Cached GGUF files in load order, with the verification manifest Otis wrote beside them. */
  files: { source: string; manifest?: string }[]
  /** The pinned runtime bundle directory that serves this model, and its directory name. */
  bundle: { source: string; name: string }
  hardware: HardwareProbe
}

/**
 * Otis data roots that may hold cached GGUFs and runtime bundles: the released and dev
 * profiles on macOS, XDG data on Linux, plus `OTIS_INTEGRATION_DATA` (colon-separated).
 */
export function candidateDataRoots() {
  const home = homedir()
  const configured = process.env.OTIS_INTEGRATION_DATA?.split(":").filter(Boolean) ?? []
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return [
    ...new Set([
      ...configured,
      join(home, "Library", "Application Support", "otis"),
      join(home, "Library", "Application Support", "otis-dev"),
      ...(xdg ? [join(xdg, "otis")] : []),
      join(home, ".local", "share", "otis"),
    ]),
  ]
}

/**
 * Catalog models whose selected packing is fully cached under some root and whose pinned
 * runtime bundle is installed under some (possibly other) root, smallest weights first.
 * Nothing is downloaded.
 */
export async function findCachedLocalModels(): Promise<{
  models: CachedLocalModel[]
  roots: string[]
}> {
  const roots = candidateDataRoots()
  const hardware = await detectHardware()
  const models: CachedLocalModel[] = []
  for (const model of LOCAL_MODELS) {
    const fit = fitLocalModel(model, hardware)
    if (!fit.available) continue
    const spec = fit.model
    const files = await cachedFiles(spec, roots)
    const bundle = await installedBundle(spec, hardware, roots)
    if (files && bundle) models.push({ spec, files, bundle, hardware })
  }
  models.sort((a, b) => localModelWeightBytes(a.spec) - localModelWeightBytes(b.spec))
  return { models, roots }
}

async function cachedFiles(spec: LocalModelSpec, roots: string[]) {
  for (const root of roots) {
    const directory = join(root, "llama", "models")
    const files: CachedLocalModel["files"] = []
    for (const file of spec.ggufFiles) {
      const source = join(directory, file.name)
      if (!(await hasSize(source, file.size))) break
      const manifest = `${source}.otis.json`
      files.push((await exists(manifest)) ? { source, manifest } : { source })
    }
    if (files.length === spec.ggufFiles.length) return files
  }
  return undefined
}

async function installedBundle(spec: LocalModelSpec, hardware: HardwareProbe, roots: string[]) {
  const target = llamaRuntimeTarget(hardware, spec.runtime)
  const releaseTag = llamaRuntimeReleaseTag(spec.runtime)
  let artifactSha256: string
  try {
    const asset = pinnedLlamaCppAsset(target, spec.runtime)
    artifactSha256 = asset.companion
      ? createHash("sha256").update(`${asset.sha256}:${asset.companion.sha256}`).digest("hex")
      : asset.sha256
  } catch {
    return undefined
  }
  const name =
    target.backend === "cuda"
      ? `${releaseTag}-cuda-${target.cudaVersion}`
      : target.backend === "cpu" && target.platform === "linux"
        ? `${releaseTag}-cpu`
        : releaseTag
  for (const root of roots) {
    const source = join(root, "llama", "bin", name)
    let manifest: Record<string, unknown>
    try {
      const info = await stat(join(source, "llama-server"))
      if (!info.isFile() || (info.mode & 0o111) === 0) continue
      manifest = JSON.parse(await readFile(join(source, ".otis-runtime.json"), "utf8"))
    } catch {
      continue
    }
    if (
      manifest.version === 2 &&
      manifest.releaseTag === releaseTag &&
      manifest.platform === target.platform &&
      manifest.arch === target.arch &&
      manifest.backend === target.backend &&
      manifest.artifactSha256 === artifactSha256
    )
      return { source, name }
  }
  return undefined
}

/**
 * Makes a cached model and its runtime available under a private Otis home without copying
 * or downloading: GGUFs are symlinked file by file (their manifests copied so verification is
 * skipped), the bundle as one directory so llama-server finds its libraries beside it. Returns
 * the staged llama-server path, which is unique to `home` and so identifies its processes.
 */
export async function stageLocalModel(home: string, model: CachedLocalModel) {
  const models = join(home, "llama", "models")
  await mkdir(models, { recursive: true, mode: 0o700 })
  for (const file of model.files) {
    await symlink(file.source, join(models, basename(file.source)))
    if (file.manifest) await copyFile(file.manifest, join(models, basename(file.manifest)))
  }
  const bin = join(home, "llama", "bin")
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const bundle = join(bin, model.bundle.name)
  await symlink(model.bundle.source, bundle)
  return join(bundle, "llama-server")
}

/** Live llama-server processes launched from `binaryPath`, by command line. */
export async function llamaServerPids(binaryPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", binaryPath])
    return stdout.trim().split("\n").filter(Boolean).map(Number)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1)
      return []
    throw error
  }
}

/** The server record this process wrote under `home`, as the runtime keeps it. */
export async function recordedServer(home: string) {
  const path = join(home, "llama", "servers", `${process.pid}.json`)
  return JSON.parse(await readFile(path, "utf8")) as {
    pid: number
    ownerPid: number
    port: number
    binaryPath: string
  }
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

async function hasSize(path: string, size: number) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size === size
  } catch {
    return false
  }
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}
