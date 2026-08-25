import { type ChildProcess, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { childProcessEnvironment } from "../local/child-environment.js"
import { llamaBinaryDirectory, llamaModelCacheDirectory } from "../local/paths.js"
import { ensureLocalGguf } from "./gguf-cache.js"
import { type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import { type GitHubRelease, latestLlamaCppRelease, selectLlamaCppAsset } from "./llama-binary.js"
import { LOCAL_MIN_CONTEXT_LENGTH, type LocalModelSpec } from "./local-catalog.js"
import type { LocalModelFit } from "./local-fit.js"

const GITHUB_RELEASES_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20"
const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000
const STOP_TIMEOUT_MS = 5_000
const KILL_WAIT_MS = 1_000
const RUNTIME_MANIFEST = ".otis-runtime.json"

export type LocalServingEndpoint = {
  model: string
  inferenceURL: string
  contextLength: number
}

export type LocalLoadProgress = { phase: "download"; percent: number } | { phase: "loading" }

export type EnsureServingOptions = {
  signal?: AbortSignal
  onProgress?: (progress: LocalLoadProgress) => void
}

export type LlamaCppRuntimeOptions = {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  spawn?: typeof spawn
  extractArchive?: (archivePath: string, destination: string) => Promise<void>
  allocatePort?: () => Promise<number>
  dataDirectory?: string
  readyTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class LlamaCppRuntime {
  #process: ChildProcess | undefined
  #serving: LocalServingEndpoint | undefined
  #servingKey: string | undefined
  #abort: AbortController | undefined
  #inflight: { key: string; promise: Promise<LocalServingEndpoint> } | undefined
  readonly #options: LlamaCppRuntimeOptions

  constructor(options: LlamaCppRuntimeOptions = {}) {
    this.#options = options
  }

  get serving() {
    return this.#serving
  }

  async ensureServing(
    model: LocalModelSpec,
    fit: LocalModelFit,
    hardware: HardwareProbe,
    options: EnsureServingOptions = {},
  ): Promise<LocalServingEndpoint> {
    if (!fit.available) {
      throw new Error(`${model.displayName} needs ${formatBytes(fit.memoryRequiredBytes)} to run on this machine.`)
    }
    const key = `${model.id}:${fit.contextLength}`
    if (
      this.#servingKey === key &&
      this.#serving?.model === model.id &&
      this.#process &&
      !processHasTerminated(this.#process)
    ) {
      return this.#serving
    }
    if (this.#inflight?.key === key) return this.#inflight.promise

    this.#abort?.abort()
    await this.#killProcess()
    this.#serving = undefined
    this.#servingKey = undefined

    const abort = new AbortController()
    this.#abort = abort
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
    const promise = this.#start(key, model, hardware, signal, options.onProgress)
    this.#inflight = { key, promise }
    try {
      return await promise
    } finally {
      if (this.#inflight?.promise === promise) this.#inflight = undefined
    }
  }

  async stop() {
    this.#abort?.abort()
    this.#abort = undefined
    this.#inflight = undefined
    this.#serving = undefined
    this.#servingKey = undefined
    await this.#killProcess()
  }

  async #killProcess(child = this.#process) {
    if (this.#process === child) this.#process = undefined
    if (!child || processHasTerminated(child)) return
    await stopProcess(child, this.#options.sleep ?? delay)
  }

  async #start(
    key: string,
    model: LocalModelSpec,
    hardware: HardwareProbe,
    signal: AbortSignal,
    onProgress: EnsureServingOptions["onProgress"],
  ) {
    const binary = await this.#resolveBinary(hardware, signal)
    signal.throwIfAborted()
    const modelPath = await ensureLocalGguf(model, {
      dataDirectory: this.#options.dataDirectory,
      env: this.#options.env,
      fetch: this.#options.fetch,
      signal,
      onProgress: (percent) => onProgress?.({ phase: "download", percent }),
    })
    signal.throwIfAborted()
    onProgress?.({ phase: "loading" })

    const port = await (this.#options.allocatePort ?? allocatePort)()
    const inferenceURL = `http://127.0.0.1:${port}/v1/chat/completions`
    const env = this.#options.env ?? process.env
    const childEnv = llamaServerEnvironment(
      env,
      this.#options.dataDirectory ? join(this.#options.dataDirectory, "models") : llamaModelCacheDirectory(),
    )

    const child = (this.#options.spawn ?? spawn)(binary, serverArgs(model, hardware, port, modelPath), {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.#process = child
    const logs: string[] = []
    const append = (chunk: Buffer | string) => {
      logs.push(String(chunk))
      if (logs.join("").length > 20_000) logs.splice(0, logs.length - 1)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    try {
      const contextLength = await this.#waitUntilReady(port, child, logs, signal)
      signal.throwIfAborted()
      if (this.#process !== child) throw new DOMException("Local model startup was superseded.", "AbortError")
      this.#serving = { model: model.id, inferenceURL, contextLength }
      this.#servingKey = key
      return this.#serving
    } catch (error) {
      // Only clean up the child owned by this start attempt. A newer request
      // may already have installed its own child in #process.
      await this.#killProcess(child)
      throw error
    }
  }

  async #resolveBinary(hardware: HardwareProbe, signal?: AbortSignal) {
    const configured = (this.#options.env ?? process.env).OTIS_LLAMA_SERVER?.trim()
    if (configured) {
      await assertExecutable(configured)
      return configured
    }

    const binaryRoot = this.#options.dataDirectory
      ? join(this.#options.dataDirectory, "bin")
      : dirname(llamaBinaryDirectory("release"))
    const cached = await findCachedLlamaServer(binaryRoot, hardware)
    if (cached) return cached

    const fetchImpl = this.#options.fetch ?? fetch
    const response = await fetchImpl(GITHUB_RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "otis" },
      signal,
    })
    if (!response.ok) throw new Error(`Could not load llama.cpp releases (HTTP ${response.status}).`)
    const releases = (await response.json()) as GitHubRelease[]
    if (!Array.isArray(releases)) throw new Error("llama.cpp releases response was invalid.")
    const release = latestLlamaCppRelease(releases)
    const asset = selectLlamaCppAsset(release, {
      platform: hardware.platform,
      arch: hardware.arch,
      backend: hardware.backend,
    })
    const binaryDir = join(binaryRoot, release.tag_name)
    const binaryPath = join(binaryDir, "llama-server")
    if (await isUsableRuntimeBundle(binaryDir, hardware)) return binaryPath

    await mkdir(binaryRoot, { recursive: true, mode: 0o700 })
    const download = await downloadToTemp(asset.browser_download_url, fetchImpl, signal)
    let extractDir: string | undefined
    let candidateDir: string | undefined
    try {
      extractDir = await mkdtemp(join(binaryRoot, `.${safePathSegment(release.tag_name)}-extract-`))
      candidateDir = `${extractDir}.bundle`
      await (this.#options.extractArchive ?? extractTarGz)(download.archivePath, extractDir)
      signal?.throwIfAborted()
      const found = await findNamedFile(extractDir, "llama-server")
      if (!found) throw new Error("llama.cpp archive did not include llama-server.")
      await chmod(found, 0o755)
      await writeRuntimeManifest(dirname(found), release.tag_name, hardware)

      // llama-server dynamically loads the libraries and backend assets shipped
      // beside it. Publish that directory atomically as one runtime bundle.
      await rename(dirname(found), candidateDir)
      await publishRuntimeBundle(candidateDir, binaryDir, `${extractDir}.previous`, hardware)
    } finally {
      if (extractDir) await rm(extractDir, { recursive: true, force: true })
      if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
      await rm(download.directory, { recursive: true, force: true })
    }
    await assertExecutable(binaryPath)
    return binaryPath
  }

  async #waitUntilReady(port: number, child: ChildProcess, logs: string[], signal: AbortSignal) {
    const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const sleep = this.#options.sleep ?? delay
    const fetchImpl = this.#options.fetch ?? fetch
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (processHasTerminated(child)) {
        throw new Error(
          `llama-server exited before becoming ready: ${logs.join("").trim() || processTermination(child)}`,
        )
      }
      let response: Response | undefined
      try {
        response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        })
      } catch {
        // Keep polling until the server binds and loads the GGUF.
      }
      if (response?.ok) return await this.#readContextLength(port, signal)
      signal.throwIfAborted()
      await sleep(200)
    }
    throw new Error("Timed out waiting for the local model server to start.")
  }

  async #readContextLength(port: number, signal: AbortSignal) {
    const fetchImpl = this.#options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/props`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new Error(`Could not read the context selected by llama-server: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      throw new Error(`Could not read the context selected by llama-server (HTTP ${response.status}).`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new Error(`llama-server returned invalid runtime properties: ${errorMessage(error)}`)
    }
    const contextLength = runtimeContextLength(body)
    if (contextLength === undefined || contextLength < LOCAL_MIN_CONTEXT_LENGTH) {
      throw new Error("llama-server did not report a valid context size.")
    }
    return contextLength
  }
}

function serverArgs(model: LocalModelSpec, hardware: HardwareProbe, port: number, modelPath: string) {
  const fitTargetMiB = inferenceMemoryBudget(hardware).deviceHeadroomBytes / 1024 ** 2
  return [
    "--model",
    modelPath,
    "--alias",
    model.id,
    "--jinja",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--parallel",
    "1",
    "--fit",
    "on",
    "--fit-target",
    String(fitTargetMiB),
    "--fit-ctx",
    String(LOCAL_MIN_CONTEXT_LENGTH),
    "--no-webui",
  ]
}

function llamaServerEnvironment(env: NodeJS.ProcessEnv, modelCache: string) {
  const childEnv = childProcessEnvironment(env)
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("LLAMA_ARG_")) delete childEnv[name]
  }
  childEnv.LLAMA_CACHE = modelCache
  return childEnv
}

async function downloadToTemp(url: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const response = await fetchImpl(url, { headers: { "user-agent": "otis" }, signal })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download llama.cpp (HTTP ${response.status}).`)
  }
  const directory = await mkdtemp(join(tmpdir(), "otis-llama-dl-"))
  const archivePath = join(directory, "llama.tar.gz")
  try {
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
    return { archivePath, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function extractTarGz(archivePath: string, destination: string) {
  await mkdir(destination, { recursive: true })
  const child = spawn("tar", ["-xzf", archivePath, "-C", destination], { stdio: "pipe" })
  const status = await waitForExit(child)
  if (status !== 0) throw new Error("Could not extract the llama.cpp archive.")
}

async function findNamedFile(root: string, fileName: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findNamedFile(path, fileName)
      if (nested) return nested
    } else if (entry.name === fileName) {
      return path
    }
  }
  return undefined
}

async function findCachedLlamaServer(binaryRoot: string, hardware: HardwareProbe) {
  try {
    const entries = await readdir(binaryRoot, { withFileTypes: true })
    const releases = entries
      .filter((entry) => entry.isDirectory() && /^b\d+$/.test(entry.name))
      .sort((left, right) => Number(right.name.slice(1)) - Number(left.name.slice(1)))
    for (const release of releases) {
      const bundle = join(binaryRoot, release.name)
      if (await isUsableRuntimeBundle(bundle, hardware)) return join(bundle, "llama-server")
    }
    return undefined
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function publishRuntimeBundle(
  candidateDir: string,
  binaryDir: string,
  previousDir: string,
  hardware: HardwareProbe,
) {
  try {
    await rename(candidateDir, binaryDir)
    return
  } catch (error) {
    // Another process may have completed the same install first.
    if (await isUsableRuntimeBundle(binaryDir, hardware)) return
    if (!isDestinationExists(error)) throw error
  }

  let displaced = false
  try {
    try {
      await rename(binaryDir, previousDir)
      displaced = true
    } catch (error) {
      if (!isNotFound(error)) throw error
    }

    try {
      await rename(candidateDir, binaryDir)
    } catch (error) {
      if (!(await isUsableRuntimeBundle(binaryDir, hardware))) throw error
    }
  } catch (error) {
    if (displaced && !(await pathExists(binaryDir))) {
      await rename(previousDir, binaryDir).catch(() => undefined)
    }
    throw error
  } finally {
    await rm(previousDir, { recursive: true, force: true })
  }
}

async function isUsableRuntimeBundle(bundleDir: string, hardware: HardwareProbe) {
  if (!(await isExecutable(join(bundleDir, "llama-server")))) return false

  let names: string[]
  try {
    names = await readdir(bundleDir)
  } catch {
    return false
  }
  if (!hasRuntimeLibraries(names, hardware.platform)) return false

  try {
    const manifest = JSON.parse(await readFile(join(bundleDir, RUNTIME_MANIFEST), "utf8")) as unknown
    return isRuntimeManifestFor(manifest, hardware)
  } catch (error) {
    if (!isNotFound(error)) return false
  }

  // Bundles installed before manifests were introduced remain reusable if
  // they contain the platform's shared-library companions. A lone executable
  // is the incomplete legacy layout and must be repaired.
  return true
}

function hasRuntimeLibraries(names: readonly string[], platform: NodeJS.Platform) {
  const suffix = platform === "darwin" ? /\.dylib$/ : /\.so(?:\.\d+)*$/
  return (
    names.some((name) => /^libllama.*\./.test(name) && suffix.test(name)) &&
    names.some((name) => /^libggml.*\./.test(name) && suffix.test(name))
  )
}

async function writeRuntimeManifest(bundleDir: string, releaseTag: string, hardware: HardwareProbe) {
  await writeFile(
    join(bundleDir, RUNTIME_MANIFEST),
    `${JSON.stringify({
      version: 1,
      releaseTag,
      platform: hardware.platform,
      arch: hardware.arch,
      backend: hardware.backend,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
}

function isRuntimeManifestFor(value: unknown, hardware: HardwareProbe) {
  if (typeof value !== "object" || value === null) return false
  const manifest = value as Record<string, unknown>
  return (
    manifest.version === 1 &&
    manifest.platform === hardware.platform &&
    manifest.arch === hardware.arch &&
    manifest.backend === hardware.backend
  )
}

async function allocatePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error("Could not allocate a local inference port.")
  return port
}

async function stopProcess(child: ChildProcess, sleep: (ms: number) => Promise<void>) {
  if (processHasTerminated(child)) return
  child.kill("SIGTERM")
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (!processHasTerminated(child) && Date.now() < deadline) await sleep(50)
  if (processHasTerminated(child)) return
  child.kill("SIGKILL")
  const killDeadline = Date.now() + KILL_WAIT_MS
  while (!processHasTerminated(child) && Date.now() < killDeadline) await sleep(50)
}

async function waitForExit(child: ChildProcess) {
  if (processHasTerminated(child)) return child.exitCode ?? 1
  return await new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1))
  })
}

function processHasTerminated(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode != null
}

function processTermination(child: ChildProcess) {
  return child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode ?? "unknown"}`
}

async function assertExecutable(path: string) {
  if (!(await isExecutable(path))) throw new Error(`llama-server is not executable: ${path}`)
}

async function isExecutable(path: string) {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function formatBytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1024 ** 3))} GB`
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isDestinationExists(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  )
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function runtimeContextLength(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const settings = (value as Record<string, unknown>).default_generation_settings
  if (typeof settings !== "object" || settings === null) return undefined
  const contextLength = (settings as Record<string, unknown>).n_ctx
  return Number.isSafeInteger(contextLength) && Number(contextLength) > 0 ? Number(contextLength) : undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
