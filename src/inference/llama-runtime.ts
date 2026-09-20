import { type ChildProcess, execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { childProcessEnvironment } from "../local/child-environment.js"
import { llamaBinaryDirectory, llamaModelCacheDirectory } from "../local/paths.js"
import { ensureLocalGguf } from "./gguf-cache.js"
import { type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import {
  type LlamaBinaryTarget,
  type LlamaCppArchive,
  type LlamaCppAsset,
  type LlamaRuntimeKind,
  llamaRuntimeReleaseTag,
  llamaRuntimeTarget,
  PINNED_LLAMA_CPP_RELEASE_TAGS,
  pinnedLlamaCppAsset,
  supportsLlamaCppTarget,
  unsupportedLlamaCppTargetMessage,
} from "./llama-binary.js"
import { LOCAL_MIN_CONTEXT_LENGTH, type LocalModelSpec } from "./local-catalog.js"
import { fitLocalModel, type LocalModelFit } from "./local-fit.js"

const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_RUNTIME_DOWNLOAD_ATTEMPTS = 3
const DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000
const RUNTIME_DOWNLOAD_RETRY_BASE_MS = 500
const MAX_RETRY_AFTER_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const KILL_WAIT_MS = 1_000
const RUNTIME_MANIFEST = ".otis-runtime.json"
const execFileAsync = promisify(execFile)

export type LocalServingEndpoint = {
  model: string
  inferenceURL: string
  contextLength: number
}

type ResolvedRuntime = {
  binaryPath: string
  hardware: HardwareProbe
  managed: boolean
  devices?: string[]
}

class LlamaServerExitError extends Error {
  constructor(
    readonly output: string,
    termination: string,
  ) {
    super(`llama-server exited before becoming ready: ${output.trim() || termination}`)
  }
}

export type LocalLoadProgress =
  | { phase: "runtime-download" }
  | { phase: "download"; percent: number }
  | { phase: "loading" }

export const LOCAL_RUNTIME_DOWNLOADING_LABEL = "Downloading llama.cpp"
export const LOCAL_DOWNLOADING_LABEL = "Downloading"
export const LOCAL_LOADING_LABEL = "Loading"

/** Short picker-row label for a managed local model being downloaded or loaded. Shared by the TUI and desktop. */
export function formatLocalLoadStatus(progress: LocalLoadProgress) {
  if (progress.phase === "runtime-download") return LOCAL_RUNTIME_DOWNLOADING_LABEL
  if (progress.phase === "download") return `${LOCAL_DOWNLOADING_LABEL} ${progress.percent}%`
  return LOCAL_LOADING_LABEL
}

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
  runtimeAsset?: (target: LlamaBinaryTarget, runtime: LlamaRuntimeKind) => LlamaCppAsset
  listDevices?: (binaryPath: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>
  dataDirectory?: string
  readyTimeoutMs?: number
  runtimeDownloadAttempts?: number
  /** Maximum wait for response headers or further archive bytes, not a total transfer deadline. */
  runtimeDownloadTimeoutMs?: number
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
    if (!supportsLlamaCppTarget(hardware)) throw new Error(unsupportedLlamaCppTargetMessage(hardware))
    if (fit.model.id !== model.id) throw new Error("Local model fit does not match the selected model.")
    model = fit.model
    hardware = llamaRuntimeTarget(hardware, model.runtime)
    if (!fit.available) {
      throw new Error(`${model.displayName} needs ${formatBytes(fit.memoryRequiredBytes)} to run on this machine.`)
    }
    const key = servingKey(model, hardware)
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
    const runtime = await this.#resolveBinary(model, hardware, signal, onProgress)
    signal.throwIfAborted()
    try {
      return await this.#loadAndStartServer(key, model, runtime, signal, onProgress)
    } catch (error) {
      signal.throwIfAborted()
      if (
        !runtime.managed ||
        runtime.hardware.backend !== "cuda" ||
        !(error instanceof LlamaServerExitError) ||
        !isCudaStartupFailure(error.output)
      )
        throw error
      const fallback = await this.#resolveBinary(
        model,
        { ...runtime.hardware, backend: "vulkan", cudaVersion: undefined },
        signal,
        onProgress,
      )
      signal.throwIfAborted()
      return await this.#loadAndStartServer(key, model, fallback, signal, onProgress)
    }
  }

  async #loadAndStartServer(
    key: string,
    model: LocalModelSpec,
    runtime: ResolvedRuntime,
    signal: AbortSignal,
    onProgress: EnsureServingOptions["onProgress"],
  ) {
    // Resolve packing after device validation, and again on startup fallback.
    // Keep the original serving key so subsequent turns reuse the fallback process.
    if (runtime.managed) {
      const fit = fitLocalModel(model, runtime.hardware)
      if (!fit.available) {
        throw new Error(`${model.displayName} needs ${formatBytes(fit.memoryRequiredBytes)} to run on this machine.`)
      }
      model = fit.model
    }
    const modelPath = await ensureLocalGguf(model, {
      dataDirectory: this.#options.dataDirectory,
      env: this.#options.env,
      fetch: this.#options.fetch,
      signal,
      onProgress: (percent) => onProgress?.({ phase: "download", percent }),
    })
    signal.throwIfAborted()
    onProgress?.({ phase: "loading" })
    return await this.#startServer(key, model, modelPath, runtime, signal)
  }

  async #startServer(
    key: string,
    model: LocalModelSpec,
    modelPath: string,
    runtime: ResolvedRuntime,
    signal: AbortSignal,
  ) {
    const port = await (this.#options.allocatePort ?? allocatePort)()
    signal.throwIfAborted()
    const inferenceURL = `http://127.0.0.1:${port}/v1/chat/completions`
    const env = this.#options.env ?? process.env
    const childEnv = llamaServerEnvironment(
      env,
      this.#options.dataDirectory ? join(this.#options.dataDirectory, "models") : llamaModelCacheDirectory(),
      runtime,
    )

    const args = serverArgs(model, runtime.hardware, port, modelPath)
    if (runtime.devices?.length) args.push("--device", runtime.devices.join(","))
    const child = (this.#options.spawn ?? spawn)(runtime.binaryPath, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.#process = child
    const logs: { value: string; spawnError?: Error } = { value: "" }
    child.on("error", (error) => {
      logs.spawnError = error
    })
    const append = (chunk: Buffer | string) => {
      logs.value = `${logs.value}${String(chunk)}`.slice(-20_000)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    try {
      const contextLength = await this.#waitUntilReady(port, child, logs, signal)
      signal.throwIfAborted()
      if (logs.spawnError) throw logs.spawnError
      if (processHasTerminated(child)) throw new LlamaServerExitError(logs.value, processTermination(child))
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

  async #resolveBinary(
    model: LocalModelSpec,
    hardware: HardwareProbe,
    signal?: AbortSignal,
    onProgress?: EnsureServingOptions["onProgress"],
  ) {
    const configured = (this.#options.env ?? process.env).OTIS_LLAMA_SERVER?.trim()
    if (configured) {
      await assertExecutable(configured)
      return { binaryPath: configured, hardware, managed: false }
    }

    const binaryRoot = this.#options.dataDirectory
      ? join(this.#options.dataDirectory, "bin")
      : dirname(llamaBinaryDirectory("release"))
    const releaseTag = llamaRuntimeReleaseTag(model.runtime)
    // Keep CUDA and Vulkan side by side so a failed CUDA device probe can reuse
    // Vulkan without redownloading either runtime on every model load.
    const bundleName = hardware.backend === "cuda" ? `${releaseTag}-cuda-${hardware.cudaVersion}` : releaseTag
    const binaryDir = join(binaryRoot, bundleName)
    const binaryPath = join(binaryDir, "llama-server")
    const asset = (this.#options.runtimeAsset ?? pinnedLlamaCppAsset)(
      {
        platform: hardware.platform,
        arch: hardware.arch,
        backend: hardware.backend,
        cudaVersion: hardware.cudaVersion,
      },
      model.runtime,
    )
    const artifactSha256 = asset.companion
      ? createHash("sha256").update(`${asset.sha256}:${asset.companion.sha256}`).digest("hex")
      : asset.sha256
    const cached = await findCachedLlamaServer(binaryDir, releaseTag, hardware, artifactSha256)
    if (cached) {
      const usable = await this.#validateGpuRuntime(cached, model, hardware, signal, onProgress)
      await removeUnpinnedRuntimeBundles(binaryRoot)
      return usable
    }

    const fetchImpl = this.#options.fetch ?? fetch
    await mkdir(binaryRoot, { recursive: true, mode: 0o700 })
    onProgress?.({ phase: "runtime-download" })
    const download = await downloadToTemp(asset, fetchImpl, {
      signal,
      attempts: this.#options.runtimeDownloadAttempts,
      timeoutMs: this.#options.runtimeDownloadTimeoutMs,
      sleep: this.#options.sleep,
    })
    let extractDir: string | undefined
    let candidateDir: string | undefined
    try {
      extractDir = await mkdtemp(join(binaryRoot, `.${releaseTag}-extract-`))
      candidateDir = `${extractDir}.bundle`
      await (this.#options.extractArchive ?? extractTarGz)(download.archivePath, extractDir)
      signal?.throwIfAborted()
      const found = await findNamedFile(extractDir, "llama-server")
      if (!found) throw new Error("llama.cpp archive did not include llama-server.")
      if (asset.companion) {
        const companion = await downloadToTemp(asset.companion, fetchImpl, {
          signal,
          attempts: this.#options.runtimeDownloadAttempts,
          timeoutMs: this.#options.runtimeDownloadTimeoutMs,
          sleep: this.#options.sleep,
        })
        try {
          const companionDir = join(extractDir, "cuda-runtime")
          await mkdir(companionDir)
          await (this.#options.extractArchive ?? extractTarGz)(companion.archivePath, companionDir)
          for (const library of cudaRuntimeLibraries(hardware)) {
            const source = await findNamedFile(companionDir, library)
            if (!source) throw new Error(`CUDA runtime archive did not include ${library}.`)
            await rename(source, join(dirname(found), library))
          }
        } finally {
          await rm(companion.directory, { recursive: true, force: true })
        }
      }
      signal?.throwIfAborted()
      await chmod(found, 0o755)
      await writeRuntimeManifest(dirname(found), releaseTag, hardware, artifactSha256)
      if (!(await isUsableRuntimeBundle(dirname(found), releaseTag, hardware, artifactSha256))) {
        throw new Error("llama.cpp archive did not include the required runtime libraries.")
      }

      // llama-server dynamically loads the libraries and backend assets shipped
      // beside it. Publish that directory atomically as one runtime bundle.
      await rename(dirname(found), candidateDir)
      await publishRuntimeBundle(
        candidateDir,
        binaryDir,
        `${extractDir}.previous`,
        releaseTag,
        hardware,
        artifactSha256,
      )
    } finally {
      if (extractDir) await rm(extractDir, { recursive: true, force: true })
      if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
      await rm(download.directory, { recursive: true, force: true })
    }
    await assertExecutable(binaryPath)
    const usable = await this.#validateGpuRuntime(binaryPath, model, hardware, signal, onProgress)
    await removeUnpinnedRuntimeBundles(binaryRoot)
    return usable
  }

  async #validateGpuRuntime(
    binaryPath: string,
    model: LocalModelSpec,
    hardware: HardwareProbe,
    signal?: AbortSignal,
    onProgress?: EnsureServingOptions["onProgress"],
  ): Promise<ResolvedRuntime> {
    const runtime = { binaryPath, hardware, managed: true }
    if (hardware.backend !== "cuda" && hardware.backend !== "vulkan") return runtime
    const modelCache = this.#options.dataDirectory
      ? join(this.#options.dataDirectory, "models")
      : llamaModelCacheDirectory()
    const env = llamaServerEnvironment(this.#options.env ?? process.env, modelCache, runtime)
    let failure = "no Vulkan device was reported"
    try {
      const devices = await (this.#options.listDevices ?? listRuntimeDevices)(binaryPath, env, signal)
      signal?.throwIfAborted()
      const expectedDevice = hardware.backend === "cuda" ? /^\s*CUDA\d+:/gm : /^\s*Vulkan\d+:/gm
      const names = Array.from(devices.matchAll(expectedDevice), ([name]) => name.trim().slice(0, -1))
      if (names.length) return { ...runtime, devices: names }
    } catch (error) {
      // A driver can be installed while unavailable inside this process/container.
      failure = errorMessage(error)
    }
    signal?.throwIfAborted()
    if (hardware.backend === "vulkan") {
      throw new Error(`Vulkan GPU acceleration is unavailable: ${failure}. Check the GPU driver and device access.`)
    }
    return await this.#resolveBinary(
      model,
      { ...hardware, backend: "vulkan", cudaVersion: undefined },
      signal,
      onProgress,
    )
  }

  async #waitUntilReady(
    port: number,
    child: ChildProcess,
    logs: { value: string; spawnError?: Error },
    signal: AbortSignal,
  ) {
    const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const sleep = this.#options.sleep ?? delay
    const fetchImpl = this.#options.fetch ?? fetch
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (logs.spawnError) throw logs.spawnError
      if (processHasTerminated(child)) {
        throw new LlamaServerExitError(logs.value, processTermination(child))
      }
      let response: Response | undefined
      try {
        response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        })
      } catch {
        // Keep polling until the server binds and loads the GGUF.
      }
      signal.throwIfAborted()
      if (logs.spawnError) throw logs.spawnError
      if (processHasTerminated(child)) throw new LlamaServerExitError(logs.value, processTermination(child))
      if (response?.ok) return await this.#readContextLength(port, signal)
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

function servingKey(model: LocalModelSpec, hardware: HardwareProbe) {
  const targetMiB = inferenceMemoryBudget(hardware).deviceHeadroomBytes / 1024 ** 2
  return JSON.stringify([
    model.id,
    llamaRuntimeReleaseTag(model.runtime),
    model.ggufRepo,
    model.ggufRevision,
    model.quant,
    model.ggufFiles,
    hardware.platform,
    hardware.arch,
    hardware.backend,
    hardware.cudaVersion,
    targetMiB,
  ])
}

function llamaServerEnvironment(env: NodeJS.ProcessEnv, modelCache: string, runtime: ResolvedRuntime) {
  const childEnv = childProcessEnvironment(env)
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("LLAMA_ARG_")) delete childEnv[name]
  }
  childEnv.LLAMA_CACHE = modelCache
  if (runtime.managed && runtime.hardware.platform === "linux") {
    // Prefer the verified bundle without discarding container/WSL driver paths.
    // Only this child receives the changes; custom server overrides retain their
    // own loader configuration. Preloaded libraries could defeat this ordering.
    childEnv.LD_LIBRARY_PATH = [
      dirname(runtime.binaryPath),
      ...(env.LD_LIBRARY_PATH?.split(/[:;]/).filter(Boolean) ?? []),
    ].join(":")
    delete childEnv.LD_PRELOAD
    delete childEnv.LD_AUDIT
    delete childEnv.GGML_BACKEND_PATH
  }
  return childEnv
}

function isCudaStartupFailure(output: string) {
  // Retry only diagnostics identifying the CUDA backend. A generic model,
  // context, host-memory, or HTTP failure must retain its original error.
  return [
    /\bCUDA error:/i,
    /\binvalid device:\s*CUDA\d+\b/i,
    /\bCUBLAS_STATUS_(?:NOT_INITIALIZED|ALLOC_FAILED|ARCH_MISMATCH|EXECUTION_FAILED|INTERNAL_ERROR|NOT_SUPPORTED)\b/,
    /\bggml_(?:backend_)?cuda\w*:[^\n]*(?:failed|error|out of memory)/i,
    /\blib(?:cuda|cudart|cublas(?:Lt)?)\.so[^\n]*(?:cannot open|undefined symbol|not found)/i,
  ].some((pattern) => pattern.test(output))
}

type RuntimeDownloadOptions = {
  signal?: AbortSignal
  attempts?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

class RetryableRuntimeDownloadError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

async function downloadToTemp(asset: LlamaCppArchive, fetchImpl: typeof fetch, options: RuntimeDownloadOptions = {}) {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RUNTIME_DOWNLOAD_ATTEMPTS)
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadToTempOnce(asset, fetchImpl, options.signal, options.timeoutMs)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!(error instanceof RetryableRuntimeDownloadError) || attempt >= attempts) throw error
      const retryDelay = error.retryAfterMs ?? RUNTIME_DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)
      await waitForRetry(retryDelay, options.signal, options.sleep)
    }
  }
}

async function downloadToTempOnce(
  asset: LlamaCppArchive,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS,
) {
  const request = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal
  let timeout: ReturnType<typeof setTimeout> | undefined
  const resetTimeout = () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      request.abort(new RetryableRuntimeDownloadError("Could not download llama.cpp: the request timed out."))
    }, timeoutMs)
  }
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let directory: string | undefined
  let file: FileHandle | undefined
  let complete = false
  try {
    requestSignal.throwIfAborted()
    resetTimeout()
    try {
      response = await fetchImpl(asset.url, { headers: { "user-agent": "otis" }, signal: requestSignal })
    } catch (error) {
      requestSignal.throwIfAborted()
      throw new RetryableRuntimeDownloadError(`Could not download llama.cpp: ${errorMessage(error)}`)
    }
    requestSignal.throwIfAborted()
    resetTimeout()
    if (!response.ok) {
      const message = `Could not download llama.cpp (HTTP ${response.status}).`
      if (isRetryableDownloadStatus(response.status)) {
        throw new RetryableRuntimeDownloadError(message, retryAfterMilliseconds(response.headers.get("retry-after")))
      }
      throw new Error(message)
    }
    if (!response.body) throw new RetryableRuntimeDownloadError("Could not download llama.cpp: empty response body.")
    const contentLengthHeader = response.headers.get("content-length")
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      throw new RetryableRuntimeDownloadError(
        "Could not download llama.cpp: the server returned an invalid content length.",
      )
    }
    if (contentLength !== undefined && contentLength !== asset.size) {
      throw new RetryableRuntimeDownloadError(
        `Could not download llama.cpp: expected ${asset.size} bytes but received ${contentLength}.`,
      )
    }
    directory = await mkdtemp(join(tmpdir(), "otis-llama-dl-"))
    const archivePath = join(directory, "llama.tar.gz")
    file = await open(archivePath, "wx", 0o600)
    const hash = createHash("sha256")
    let received = 0
    reader = response.body.getReader()
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        requestSignal.throwIfAborted()
        throw new RetryableRuntimeDownloadError(`Could not download llama.cpp: ${errorMessage(error)}`)
      }
      requestSignal.throwIfAborted()
      const { done, value } = chunk
      if (done) break
      if (!value || value.byteLength === 0) continue
      resetTimeout()
      if (received + value.byteLength > asset.size) {
        throw new RetryableRuntimeDownloadError(
          "Could not download llama.cpp: the response exceeded the pinned artifact size.",
        )
      }
      await file.writeFile(value)
      hash.update(value)
      received += value.byteLength
    }
    clearTimeout(timeout)
    signal?.throwIfAborted()
    if (received !== asset.size) {
      throw new RetryableRuntimeDownloadError(
        `Could not download llama.cpp: expected ${asset.size} bytes but received ${received}.`,
      )
    }
    if (hash.digest("hex") !== asset.sha256) {
      throw new RetryableRuntimeDownloadError("Could not download llama.cpp: SHA-256 verification failed.")
    }
    await file.close()
    file = undefined
    complete = true
    return { archivePath, directory }
  } finally {
    clearTimeout(timeout)
    if (!complete) {
      request.abort()
      const body = reader ?? response?.body
      await body?.cancel().catch(() => undefined)
    }
    reader?.releaseLock()
    await file?.close().catch(() => undefined)
    if (!complete && directory) await rm(directory, { recursive: true, force: true })
  }
}

function isRetryableDownloadStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) return undefined
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS)
}

async function waitForRetry(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>) {
  signal?.throwIfAborted()
  if (sleep) {
    await sleep(ms)
    signal?.throwIfAborted()
    return
  }
  await abortableDelay(ms, signal)
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  if (!signal) return delay(ms)
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
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

async function findCachedLlamaServer(
  binaryDir: string,
  releaseTag: string,
  hardware: HardwareProbe,
  artifactSha256: string,
) {
  return (await isUsableRuntimeBundle(binaryDir, releaseTag, hardware, artifactSha256))
    ? join(binaryDir, "llama-server")
    : undefined
}

async function removeUnpinnedRuntimeBundles(binaryRoot: string) {
  let entries: Dirent[]
  try {
    entries = await readdir(binaryRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  const pinned = new Set<string>(PINNED_LLAMA_CPP_RELEASE_TAGS)
  const stale = entries.filter((entry) => {
    const tag = /^(b\d+|prism-b\d+-[a-f0-9]+)(?:-cuda-\d+\.\d+)?$/.exec(entry.name)?.[1]
    return entry.isDirectory() && tag !== undefined && !pinned.has(tag)
  })
  await Promise.allSettled(stale.map((entry) => rm(join(binaryRoot, entry.name), { recursive: true, force: true })))
}

async function publishRuntimeBundle(
  candidateDir: string,
  binaryDir: string,
  previousDir: string,
  releaseTag: string,
  hardware: HardwareProbe,
  artifactSha256: string,
) {
  try {
    await rename(candidateDir, binaryDir)
    return
  } catch (error) {
    // Another process may have completed the same install first.
    if (await isUsableRuntimeBundle(binaryDir, releaseTag, hardware, artifactSha256)) return
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
      if (!(await isUsableRuntimeBundle(binaryDir, releaseTag, hardware, artifactSha256))) throw error
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

async function isUsableRuntimeBundle(
  bundleDir: string,
  releaseTag: string,
  hardware: HardwareProbe,
  artifactSha256: string,
) {
  if (!(await isExecutable(join(bundleDir, "llama-server")))) return false

  let names: string[]
  try {
    names = await readdir(bundleDir)
  } catch {
    return false
  }
  if (!hasRuntimeLibraries(names, hardware.platform)) return false
  if (hardware.backend === "cuda") {
    if (!hardware.cudaVersion || !names.includes("libggml-cuda.so")) return false
    for (const library of cudaRuntimeLibraries(hardware)) {
      if (!names.includes(library) || !(await stat(join(bundleDir, library)).catch(() => undefined))?.isFile())
        return false
    }
  }

  try {
    const manifest = JSON.parse(await readFile(join(bundleDir, RUNTIME_MANIFEST), "utf8")) as unknown
    return isRuntimeManifestFor(manifest, releaseTag, hardware, artifactSha256)
  } catch (error) {
    if (!isNotFound(error)) return false
  }

  // Bundles installed before manifests were introduced remain reusable if
  // they contain the platform's shared-library companions. A lone executable
  // is the incomplete legacy layout and must be repaired.
  return hardware.backend !== "cuda"
}

function cudaRuntimeLibraries(hardware: HardwareProbe) {
  if (hardware.backend !== "cuda" || !hardware.cudaVersion) return []
  const major = hardware.cudaVersion.split(".")[0]
  return [`libcudart.so.${major}`, `libcublas.so.${major}`, `libcublasLt.so.${major}`]
}

async function listRuntimeDevices(binaryPath: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const result = await execFileAsync(binaryPath, ["--list-devices"], {
    env,
    signal,
    timeout: 15_000,
    maxBuffer: 1024 ** 2,
  })
  return result.stdout
}

function hasRuntimeLibraries(names: readonly string[], platform: NodeJS.Platform) {
  const suffix = platform === "darwin" ? /\.dylib$/ : /\.so(?:\.\d+)*$/
  return (
    names.some((name) => /^libllama.*\./.test(name) && suffix.test(name)) &&
    names.some((name) => /^libggml.*\./.test(name) && suffix.test(name))
  )
}

async function writeRuntimeManifest(
  bundleDir: string,
  releaseTag: string,
  hardware: HardwareProbe,
  artifactSha256: string,
) {
  await writeFile(
    join(bundleDir, RUNTIME_MANIFEST),
    `${JSON.stringify({
      version: 2,
      releaseTag,
      platform: hardware.platform,
      arch: hardware.arch,
      backend: hardware.backend,
      cudaVersion: hardware.cudaVersion,
      artifactSha256,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
}

function isRuntimeManifestFor(value: unknown, releaseTag: string, hardware: HardwareProbe, artifactSha256: string) {
  if (typeof value !== "object" || value === null) return false
  const manifest = value as Record<string, unknown>
  const matchesTarget =
    manifest.releaseTag === releaseTag &&
    manifest.platform === hardware.platform &&
    manifest.arch === hardware.arch &&
    manifest.backend === hardware.backend
  if (!matchesTarget) return false
  if (hardware.backend === "cuda" && manifest.cudaVersion !== hardware.cudaVersion) return false
  if (manifest.version === 1) return hardware.backend !== "cuda"
  return manifest.version === 2 && manifest.artifactSha256 === artifactSha256
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
