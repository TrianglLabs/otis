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
import {
  llamaBinaryDirectory,
  llamaModelCacheDirectory,
  llamaServerRecordPath,
} from "../local/paths.js"
import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { errorMessage, inferenceResponseError } from "./errors.js"
import { ensureLocalGguf } from "./gguf-cache.js"
import { type HardwareBackend, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
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
import type { LocalModelSpec } from "./local-catalog.js"
import { fitLocalModel, type LocalModelFit } from "./local-fit.js"
import { localThinkingParameters, minimalLocalThinkingLevel } from "./local-thinking.js"
import { parseChatCompletionStream } from "./stream-parser.js"

const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_RUNTIME_DOWNLOAD_ATTEMPTS = 3
const DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000
const RUNTIME_DOWNLOAD_RETRY_BASE_MS = 500
const MAX_RETRY_AFTER_MS = 30_000
const GENERATION_CHECK_TIMEOUT_MS = 120_000
/** Layers held in system RAM decode slowly; a large model can need minutes for a few tokens. */
const SLOW_GENERATION_CHECK_TIMEOUT_MS = 10 * 60 * 1000
const STOP_TIMEOUT_MS = 5_000
const KILL_WAIT_MS = 1_000
const EXIT_TAIL_BYTES = 2_048
const RUNTIME_MANIFEST = ".otis-runtime.json"
const SERVER_RECORD = "server.json"
const execFileAsync = promisify(execFile)

// Retry on the next backend only for diagnostics identifying this backend. A generic model,
// context, host-memory, or HTTP failure must retain its original error.
const BACKEND_FAILURES: Partial<Record<HardwareBackend, readonly RegExp[]>> = {
  cuda: [
    /\bCUDA error:/i,
    /\binvalid device:\s*CUDA\d+\b/i,
    /\bCUBLAS_STATUS_(?:NOT_INITIALIZED|ALLOC_FAILED|ARCH_MISMATCH|EXECUTION_FAILED|INTERNAL_ERROR|NOT_SUPPORTED)\b/,
    /\bggml_(?:backend_)?cuda\w*:[^\n]*(?:failed|error|out of memory)/i,
    /\blib(?:cuda|cudart|cublas(?:Lt)?)\.so[^\n]*(?:cannot open|undefined symbol|not found)/i,
  ],
  vulkan: [
    /\bggml_vulkan\b/i,
    /\bvk::\w+/,
    /\bVK_ERROR_\w+/,
    /\bVulkan\b[^\n]*(?:error|failed|lost|unavailable|no devices)/i,
    /\blibvulkan\.so[^\n]*(?:cannot open|undefined symbol|not found)/i,
  ],
}
const BACKEND_LABEL: Record<HardwareBackend, string> = {
  cuda: "CUDA",
  vulkan: "Vulkan",
  metal: "Metal",
  cpu: "CPU",
}
const BIND_FAILURE =
  /\b(?:couldn't|could not|failed to|unable to) bind\b|\baddress already in use\b|\bEADDRINUSE\b/i

// llama-server needs loader, GPU, locale, and display settings only. Hugging Face and provider
// credentials in the parent environment never reach the server or its device probe.
const SERVER_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
])
const SERVER_ENV_PREFIXES = ["LC_", "LD_", "CUDA_", "NVIDIA_", "GGML_", "VK_", "MTL_", "XDG_"]

type LocalServingEndpoint = {
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

type ServerLogs = { value: string; spawnError?: Error }

type ServerExit = { code: number | null; signal: NodeJS.Signals | null; tail: string }

class LlamaServerExitError extends Error {
  constructor(
    readonly output: string,
    child: ChildProcess,
  ) {
    const termination = child.signalCode
      ? `signal ${child.signalCode}`
      : `code ${child.exitCode ?? "unknown"}`
    super(`llama-server exited before becoming ready: ${output.trim() || termination}`)
  }
}

class RetryableRuntimeDownloadError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export type LocalLoadProgress =
  | { phase: "runtime-download" }
  | { phase: "download"; percent: number }
  | { phase: "loading" }

const LOCAL_RUNTIME_DOWNLOADING_LABEL = "Downloading llama.cpp"
const LOCAL_DOWNLOADING_LABEL = "Downloading"
const LOCAL_LOADING_LABEL = "Loading"

/**
 * Short picker-row label for a managed local model being downloaded or loaded. Shared by the
 * TUI and desktop.
 */
export function formatLocalLoadStatus(progress: LocalLoadProgress) {
  if (progress.phase === "runtime-download") return LOCAL_RUNTIME_DOWNLOADING_LABEL
  if (progress.phase === "download") return `${LOCAL_DOWNLOADING_LABEL} ${progress.percent}%`
  return LOCAL_LOADING_LABEL
}

type EnsureServingOptions = {
  signal?: AbortSignal
  onProgress?: (progress: LocalLoadProgress) => void
  /** One-time human-readable notices, such as a backend fallback and its cause. */
  onNotice?: (message: string) => void
}

type StartContext = Omit<EnsureServingOptions, "signal"> & { signal: AbortSignal }

type LlamaCppRuntimeOptions = {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  spawn?: typeof spawn
  extractArchive?: (archivePath: string, destination: string) => Promise<void>
  allocatePort?: () => Promise<number>
  runtimeAsset?: (target: LlamaBinaryTarget, runtime: LlamaRuntimeKind) => LlamaCppAsset
  listDevices?: (
    binaryPath: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string>
  /** The command line of a recorded server pid (`ps -o args=`); empty when it is gone. */
  processCommand?: (pid: number) => Promise<string>
  /** `process.kill`, including the liveness probe with signal 0. */
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void
  dataDirectory?: string
  readyTimeoutMs?: number
  generationCheckTimeoutMs?: number
  runtimeDownloadAttempts?: number
  /** Maximum wait for response headers or further archive bytes, not a total transfer deadline. */
  runtimeDownloadTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class LlamaCppRuntime {
  #process: ChildProcess | undefined
  #serving: LocalServingEndpoint | undefined
  #servingKey: string | undefined
  #exit: ServerExit | undefined
  #abort: AbortController | undefined
  #inflight: { key: string; promise: Promise<LocalServingEndpoint> } | undefined
  readonly #options: LlamaCppRuntimeOptions

  constructor(options: LlamaCppRuntimeOptions = {}) {
    this.#options = options
  }

  get serving() {
    return this.#serving
  }

  /** Throws when the managed server exited after it was last known ready. */
  assertServing() {
    if (!this.#exit) return
    const { code, signal, tail } = this.#exit
    const termination = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
    throw new Error(
      `The local model server exited unexpectedly (${termination}).` +
        `${tail ? `\n${tail}` : ""}\nReselect the model to restart it.`,
    )
  }

  async ensureServing(
    model: LocalModelSpec,
    fit: LocalModelFit,
    hardware: HardwareProbe,
    options: EnsureServingOptions = {},
  ): Promise<LocalServingEndpoint> {
    if (!supportsLlamaCppTarget(hardware))
      throw new Error(unsupportedLlamaCppTargetMessage(hardware))
    model = fit.model
    hardware = llamaRuntimeTarget(hardware, model.runtime)
    if (!fit.available) throw unavailableError(fit)
    const key = JSON.stringify([
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
      inferenceMemoryBudget(hardware).deviceHeadroomBytes / 1024 ** 2,
    ])
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
    this.#exit = undefined

    const abort = new AbortController()
    this.#abort = abort
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
    const promise = this.#start(key, fit, hardware, { ...options, signal })
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
    this.#exit = undefined
    await this.#killProcess()
  }

  async #killProcess(child = this.#process) {
    if (this.#process === child) this.#process = undefined
    if (!child) return
    if (!processHasTerminated(child)) {
      await this.#terminate(
        (signal) => child.kill(signal),
        () => processHasTerminated(child),
      )
    }
    // A child that survived SIGKILL keeps its record, so the next start reaps it.
    if (processHasTerminated(child)) await this.#forgetServer(child.pid)
  }

  async #terminate(kill: (signal: NodeJS.Signals) => void, terminated: () => boolean) {
    const sleep = this.#options.sleep ?? delay
    for (const [signal, waitMs] of [
      ["SIGTERM", STOP_TIMEOUT_MS],
      ["SIGKILL", KILL_WAIT_MS],
    ] as const) {
      kill(signal)
      const deadline = Date.now() + waitMs
      while (!terminated() && Date.now() < deadline) await sleep(50)
      if (terminated()) return
    }
  }

  #processAlive(pid: number) {
    try {
      ;(this.#options.signalProcess ?? signalProcess)(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) === "EPERM"
    }
  }

  #recordPath() {
    return this.#options.dataDirectory
      ? join(this.#options.dataDirectory, SERVER_RECORD)
      : llamaServerRecordPath()
  }

  async #recordServer(child: ChildProcess, port: number, binaryPath: string) {
    if (child.pid === undefined) return
    const record = {
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binaryPath,
      startedAt: new Date().toISOString(),
    }
    const path = this.#recordPath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
  }

  async #forgetServer(pid: number | undefined) {
    if (pid === undefined) return
    const path = this.#recordPath()
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown } | null
      if (record?.pid === pid) await rm(path, { force: true })
    } catch {
      // Absent, or a newer server's record.
    }
  }

  /** A crashed Otis leaves its llama-server running; reap that orphan before starting another. */
  async #reapRecordedServer() {
    const path = this.#recordPath()
    let record: { pid?: unknown; ownerPid?: unknown; binaryPath?: unknown } | null = null
    try {
      record = JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if (isNotFound(error)) return
    }
    const pid = Number(record?.pid)
    const owner = Number(record?.ownerPid)
    // Another running Otis owns a live record; only an orphan is reaped.
    if (
      owner !== process.pid &&
      Number.isSafeInteger(owner) &&
      owner > 0 &&
      this.#processAlive(owner)
    )
      return
    if (Number.isSafeInteger(pid) && pid > 0 && this.#processAlive(pid)) {
      const command = await (this.#options.processCommand ?? processCommand)(pid)
      if (typeof record?.binaryPath === "string" && command.includes(record.binaryPath)) {
        const signal = this.#options.signalProcess ?? signalProcess
        await this.#terminate(
          (name) => {
            try {
              signal(pid, name)
            } catch {
              // Gone between the liveness probe and the signal.
            }
          },
          () => !this.#processAlive(pid),
        )
      }
    }
    await rm(path, { force: true })
  }

  async #start(key: string, fit: LocalModelFit, hardware: HardwareProbe, context: StartContext) {
    const { signal } = context
    const { model } = fit
    await this.#reapRecordedServer()
    signal.throwIfAborted()
    // Backends fall back in one direction only: CUDA to Vulkan to CPU, never back.
    const failures: string[] = []
    try {
      let runtime = await this.#resolveBinary(model, hardware, context, failures)
      for (;;) {
        signal.throwIfAborted()
        try {
          return await this.#loadAndStartServer(key, model, fit, runtime, context)
        } catch (error) {
          signal.throwIfAborted()
          const { backend } = runtime.hardware
          const next: HardwareBackend | undefined =
            backend === "cuda" ? "vulkan" : backend === "vulkan" ? "cpu" : undefined
          if (
            !runtime.managed ||
            !next ||
            !(error instanceof LlamaServerExitError) ||
            !isBackendFailure(backend, error.output)
          )
            throw error
          failures.push(`${BACKEND_LABEL[backend]} failed (${briefCause(backend, error.output)})`)
          const fallback = { ...runtime.hardware, backend: next, cudaVersion: undefined }
          runtime = await this.#resolveBinary(model, fallback, context, failures)
        }
      }
    } catch (error) {
      // Keep the abandoned backend's cause with whatever failed after it.
      if (!failures.length || signal.aborted) throw error
      throw new Error(`${errorMessage(error)}\nEarlier: ${failures.join("; ")}.`, { cause: error })
    }
  }

  async #loadAndStartServer(
    key: string,
    model: LocalModelSpec,
    fit: LocalModelFit,
    runtime: ResolvedRuntime,
    context: StartContext,
  ) {
    const { signal, onProgress } = context
    // Resolve packing after device validation, and again on startup fallback.
    // Keep the original serving key so subsequent turns reuse the fallback process.
    if (runtime.managed) {
      fit = fitLocalModel(model, runtime.hardware)
      if (!fit.available) throw unavailableError(fit)
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

    for (let attempt = 1; ; attempt += 1) {
      const port = await (this.#options.allocatePort ?? allocatePort)()
      signal.throwIfAborted()
      try {
        return await this.#serve(key, model, fit, runtime, modelPath, port, signal)
      } catch (error) {
        // Another process can take the port between allocation and bind; try one fresh port.
        if (
          attempt > 1 ||
          !(error instanceof LlamaServerExitError) ||
          !BIND_FAILURE.test(error.output)
        )
          throw error
      }
    }
  }

  async #serve(
    key: string,
    model: LocalModelSpec,
    fit: LocalModelFit,
    runtime: ResolvedRuntime,
    modelPath: string,
    port: number,
    signal: AbortSignal,
  ) {
    const inferenceURL = `http://127.0.0.1:${port}/v1/chat/completions`
    const fitTargetMiB = inferenceMemoryBudget(runtime.hardware).deviceHeadroomBytes / 1024 ** 2
    const args = [
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
    if (runtime.devices?.length) args.push("--device", runtime.devices.join(","))
    const child = (this.#options.spawn ?? spawn)(runtime.binaryPath, args, {
      env: this.#serverEnvironment(runtime),
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.#process = child
    const logs: ServerLogs = { value: "" }
    child.on("error", (error) => {
      logs.spawnError = error
    })
    const append = (chunk: Buffer | string) => {
      logs.value = `${logs.value}${String(chunk)}`.slice(-20_000)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    // This listener outlives startup: a server that dies mid-session is reported by
    // assertServing on the next request, and its record stops naming a live process.
    child.once("exit", (code, exitSignal) => {
      if (this.#process === child && this.#serving)
        this.#exit = { code, signal: exitSignal, tail: logs.value.slice(-EXIT_TAIL_BYTES).trim() }
      void this.#forgetServer(child.pid)
    })

    const exited = new AbortController()
    const onExit = () => exited.abort(new LlamaServerExitError(logs.value, child))
    child.once("exit", onExit)
    const startupSignal = AbortSignal.any([signal, exited.signal])
    try {
      await this.#recordServer(child, port, runtime.binaryPath)
      const contextLength = await this.#waitUntilReady(port, child, logs, startupSignal)
      const slow = fit.requiresCpuOffload || runtime.hardware.backend === "cpu"
      await checkLlamaGeneration({
        model: model.id,
        inferenceURL,
        signal: startupSignal,
        fetch: this.#options.fetch,
        timeoutMs:
          this.#options.generationCheckTimeoutMs ??
          (slow ? SLOW_GENERATION_CHECK_TIMEOUT_MS : GENERATION_CHECK_TIMEOUT_MS),
      })
      startupSignal.throwIfAborted()
      if (logs.spawnError) throw logs.spawnError
      if (processHasTerminated(child)) throw new LlamaServerExitError(logs.value, child)
      if (this.#process !== child)
        throw new DOMException("Local model startup was superseded.", "AbortError")
      this.#serving = { model: model.id, inferenceURL, contextLength }
      this.#servingKey = key
      return this.#serving
    } catch (error) {
      // Only clean up the child owned by this start attempt. A newer request
      // may already have installed its own child in #process.
      await this.#killProcess(child)
      throw error
    } finally {
      child.off("exit", onExit)
    }
  }

  #serverEnvironment(runtime: ResolvedRuntime) {
    const env = this.#options.env ?? process.env
    const prefixes =
      runtime.hardware.platform === "darwin"
        ? [...SERVER_ENV_PREFIXES, "DYLD_"]
        : SERVER_ENV_PREFIXES
    const childEnv: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(env)) {
      if (SERVER_ENV_NAMES.has(name) || prefixes.some((prefix) => name.startsWith(prefix)))
        childEnv[name] = value
    }
    childEnv.LLAMA_CACHE = this.#options.dataDirectory
      ? join(this.#options.dataDirectory, "models")
      : llamaModelCacheDirectory()
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

  async #resolveBinary(
    model: LocalModelSpec,
    hardware: HardwareProbe,
    context: StartContext,
    failures: string[],
  ): Promise<ResolvedRuntime> {
    const { signal, onProgress, onNotice } = context
    const configured = (this.#options.env ?? process.env).OTIS_LLAMA_SERVER?.trim()
    if (configured) {
      await assertExecutable(configured)
      return { binaryPath: configured, hardware, managed: false }
    }

    const binaryRoot = this.#options.dataDirectory
      ? join(this.#options.dataDirectory, "bin")
      : dirname(llamaBinaryDirectory("release"))
    const releaseTag = llamaRuntimeReleaseTag(model.runtime)
    // Keep CUDA, Vulkan, and the Linux CPU bundle side by side so a failed device probe can
    // reuse the next backend without redownloading either runtime on every model load.
    const bundleName =
      hardware.backend === "cuda"
        ? `${releaseTag}-cuda-${hardware.cudaVersion}`
        : hardware.backend === "cpu" && hardware.platform === "linux"
          ? `${releaseTag}-cpu`
          : releaseTag
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
    if (!(await isUsableRuntimeBundle(binaryDir, releaseTag, hardware, artifactSha256))) {
      await mkdir(binaryRoot, { recursive: true, mode: 0o700 })
      onProgress?.({ phase: "runtime-download" })
      const extract = this.#options.extractArchive ?? extractTarGz
      const download = await this.#downloadToTemp(asset, signal)
      let extractDir: string | undefined
      let candidateDir: string | undefined
      try {
        extractDir = await mkdtemp(join(binaryRoot, `.${releaseTag}-extract-`))
        candidateDir = `${extractDir}.bundle`
        await extract(download.archivePath, extractDir)
        signal.throwIfAborted()
        const found = await findNamedFile(extractDir, "llama-server")
        if (!found) throw new Error("llama.cpp archive did not include llama-server.")
        if (asset.companion) {
          const companion = await this.#downloadToTemp(asset.companion, signal)
          try {
            const companionDir = join(extractDir, "cuda-runtime")
            await mkdir(companionDir)
            await extract(companion.archivePath, companionDir)
            for (const library of cudaRuntimeLibraries(hardware)) {
              const source = await findNamedFile(companionDir, library)
              if (!source) throw new Error(`CUDA runtime archive did not include ${library}.`)
              await rename(source, join(dirname(found), library))
            }
          } finally {
            await rm(companion.directory, { recursive: true, force: true })
          }
        }
        signal.throwIfAborted()
        await chmod(found, 0o755)
        const manifest = {
          version: 2,
          releaseTag,
          platform: hardware.platform,
          arch: hardware.arch,
          backend: hardware.backend,
          cudaVersion: hardware.cudaVersion,
          artifactSha256,
        }
        await writeFile(join(dirname(found), RUNTIME_MANIFEST), `${JSON.stringify(manifest)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        })
        if (!(await isUsableRuntimeBundle(dirname(found), releaseTag, hardware, artifactSha256))) {
          throw new Error("llama.cpp archive did not include the required runtime libraries.")
        }

        // llama-server dynamically loads the libraries and backend assets shipped
        // beside it. Publish that directory atomically as one runtime bundle.
        await rename(dirname(found), candidateDir)
        const usable = () => isUsableRuntimeBundle(binaryDir, releaseTag, hardware, artifactSha256)
        await publishRuntimeBundle(candidateDir, binaryDir, `${extractDir}.previous`, usable)
      } finally {
        if (extractDir) await rm(extractDir, { recursive: true, force: true })
        if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
        await rm(download.directory, { recursive: true, force: true })
      }
      await assertExecutable(binaryPath)
    }

    const runtime = { binaryPath, hardware, managed: true }
    const label = BACKEND_LABEL[hardware.backend]
    const notice = () => {
      if (failures.length) onNotice?.(`${failures.join(" and ")}; running on ${label}.`)
    }
    if (hardware.backend !== "cuda" && hardware.backend !== "vulkan") {
      await removeUnpinnedRuntimeBundles(binaryRoot)
      notice()
      return runtime
    }
    let failure = `no ${label} device was reported`
    try {
      const env = this.#serverEnvironment(runtime)
      const devices = await (this.#options.listDevices ?? listRuntimeDevices)(
        binaryPath,
        env,
        signal,
      )
      signal.throwIfAborted()
      const expectedDevice = hardware.backend === "cuda" ? /^\s*CUDA\d+:/gm : /^\s*Vulkan\d+:/gm
      const names = Array.from(devices.matchAll(expectedDevice), ([name]) =>
        name.trim().slice(0, -1),
      )
      if (names.length) {
        await removeUnpinnedRuntimeBundles(binaryRoot)
        notice()
        return { ...runtime, devices: names }
      }
    } catch (error) {
      // A driver can be installed while unavailable inside this process/container.
      failure = errorMessage(error)
    }
    signal.throwIfAborted()
    failures.push(`${label} failed (${failure})`)
    const next: HardwareBackend = hardware.backend === "cuda" ? "vulkan" : "cpu"
    const fallback = { ...hardware, backend: next, cudaVersion: undefined }
    return await this.#resolveBinary(model, fallback, context, failures)
  }

  async #waitUntilReady(port: number, child: ChildProcess, logs: ServerLogs, signal: AbortSignal) {
    const sleep = this.#options.sleep ?? delay
    const fetchImpl = this.#options.fetch ?? fetch
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    const assertRunning = () => {
      signal.throwIfAborted()
      if (logs.spawnError) throw logs.spawnError
      if (processHasTerminated(child)) throw new LlamaServerExitError(logs.value, child)
    }
    const request = (path: string) =>
      fetchImpl(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
    while (Date.now() < deadline) {
      assertRunning()
      // Keep polling until the server binds and loads the GGUF.
      const healthy = await request("/health").then(
        (response) => response.ok,
        () => false,
      )
      assertRunning()
      if (!healthy) {
        await sleep(200)
        continue
      }
      let response: Response
      try {
        response = await request("/props")
      } catch (error) {
        signal.throwIfAborted()
        throw new Error(
          `Could not read the context selected by llama-server: ${errorMessage(error)}`,
        )
      }
      if (!response.ok) {
        throw new Error(
          `Could not read the context selected by llama-server (HTTP ${response.status}).`,
        )
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        throw new Error(`llama-server returned invalid runtime properties: ${errorMessage(error)}`)
      }
      const settings = (body as { default_generation_settings?: { n_ctx?: unknown } } | null)
        ?.default_generation_settings
      const contextLength = settings?.n_ctx
      if (
        !Number.isSafeInteger(contextLength) ||
        Number(contextLength) < LOCAL_MIN_CONTEXT_LENGTH
      ) {
        throw new Error("llama-server did not report a valid context size.")
      }
      return Number(contextLength)
    }
    throw new Error("Timed out waiting for the local model server to start.")
  }

  async #downloadToTemp(asset: LlamaCppArchive, signal?: AbortSignal) {
    const fetchImpl = this.#options.fetch ?? fetch
    const attempts = Math.max(
      1,
      this.#options.runtimeDownloadAttempts ?? DEFAULT_RUNTIME_DOWNLOAD_ATTEMPTS,
    )
    const timeoutMs = this.#options.runtimeDownloadTimeoutMs ?? DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS
    const retryable = (detail: string) =>
      new RetryableRuntimeDownloadError(`Could not download llama.cpp: ${detail}`)
    for (let attempt = 1; ; attempt += 1) {
      const request = new AbortController()
      const requestSignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal
      let timeout: ReturnType<typeof setTimeout> | undefined
      const resetTimeout = () => {
        clearTimeout(timeout)
        timeout = setTimeout(() => request.abort(retryable("the request timed out.")), timeoutMs)
      }
      let response: Response | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let directory: string | undefined
      let file: FileHandle | undefined
      let complete = false
      try {
        try {
          requestSignal.throwIfAborted()
          resetTimeout()
          try {
            response = await fetchImpl(asset.url, {
              headers: { "user-agent": "otis" },
              signal: requestSignal,
            })
          } catch (error) {
            requestSignal.throwIfAborted()
            throw retryable(errorMessage(error))
          }
          requestSignal.throwIfAborted()
          resetTimeout()
          if (!response.ok) {
            const message = `Could not download llama.cpp (HTTP ${response.status}).`
            const status = response.status
            if (status !== 408 && status !== 429 && (status < 500 || status > 599))
              throw new Error(message)
            const retryAfter = response.headers.get("retry-after")
            const seconds = Number(retryAfter)
            const ms = !retryAfter
              ? Number.NaN
              : Number.isFinite(seconds) && seconds >= 0
                ? seconds * 1_000
                : Date.parse(retryAfter) - Date.now()
            const retryAfterMs =
              Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined
            throw new RetryableRuntimeDownloadError(message, retryAfterMs)
          }
          if (!response.body) throw retryable("empty response body.")
          const contentLengthHeader = response.headers.get("content-length")
          const contentLength =
            contentLengthHeader === null ? undefined : Number(contentLengthHeader)
          if (
            contentLength !== undefined &&
            (!Number.isSafeInteger(contentLength) || contentLength < 0)
          ) {
            throw retryable("the server returned an invalid content length.")
          }
          if (contentLength !== undefined && contentLength !== asset.size) {
            throw retryable(`expected ${asset.size} bytes but received ${contentLength}.`)
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
              throw retryable(errorMessage(error))
            }
            requestSignal.throwIfAborted()
            const { done, value } = chunk
            if (done) break
            if (!value?.byteLength) continue
            resetTimeout()
            if (received + value.byteLength > asset.size) {
              throw retryable("the response exceeded the pinned artifact size.")
            }
            await file.writeFile(value)
            hash.update(value)
            received += value.byteLength
          }
          clearTimeout(timeout)
          signal?.throwIfAborted()
          if (received !== asset.size)
            throw retryable(`expected ${asset.size} bytes but received ${received}.`)
          if (hash.digest("hex") !== asset.sha256) throw retryable("SHA-256 verification failed.")
          await file.close()
          file = undefined
          complete = true
          return { archivePath, directory }
        } finally {
          clearTimeout(timeout)
          if (!complete) {
            request.abort()
            await (reader ?? response?.body)?.cancel().catch(() => undefined)
          }
          reader?.releaseLock()
          await file?.close().catch(() => undefined)
          if (!complete && directory) await rm(directory, { recursive: true, force: true })
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (!(error instanceof RetryableRuntimeDownloadError) || attempt >= attempts) throw error
        const retryDelay = error.retryAfterMs ?? RUNTIME_DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)
        if (this.#options.sleep) {
          await this.#options.sleep(retryDelay)
          signal?.throwIfAborted()
        } else if (!signal) {
          await delay(retryDelay)
        } else {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer)
              reject(signal.reason)
            }
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort)
              resolve()
            }, retryDelay)
            signal.addEventListener("abort", abort, { once: true })
          })
        }
      }
    }
  }
}

function isBackendFailure(backend: HardwareBackend, output: string) {
  return BACKEND_FAILURES[backend]?.some((pattern) => pattern.test(output)) ?? false
}

/** The diagnostic line that identified the backend failure, for notices and carried errors. */
function briefCause(backend: HardwareBackend, output: string) {
  const lines = output.trim().split("\n").reverse()
  const line = (lines.find((line) => isBackendFailure(backend, line)) ?? lines[0] ?? "").trim()
  return line.length > 200 ? `…${line.slice(-200)}` : line || "no diagnostic output"
}

/** Startup-only probe for an Otis-owned server. No conversation, tools, or usage recording. */
async function checkLlamaGeneration(options: {
  model: string
  inferenceURL: string
  signal: AbortSignal
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? GENERATION_CHECK_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])
  let response: Response | undefined
  try {
    signal.throwIfAborted()
    response = await (options.fetch ?? fetch)(options.inferenceURL, {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
        // The probe proves the server generates; the least thinking the template allows keeps
        // it short even where a maximum-effort thinker would otherwise reason for minutes.
        max_tokens: 8,
        ...localThinkingParameters(options.model, minimalLocalThinkingLevel(options.model)),
      }),
      signal,
      redirect: "error",
    })
    if (!response.ok) throw await inferenceResponseError(response, "Local model generation check")
    if (!response.body) throw new Error("The server returned no response body.")

    let generated = false
    let finished = false
    for await (const event of parseChatCompletionStream(response.body)) {
      signal.throwIfAborted()
      if (event.type === "text_delta" || event.type === "reasoning_delta") {
        if (event.text.trim()) generated = true
      }
      if (event.type === "tool_call")
        throw new Error("The server returned an unexpected tool call.")
      if (event.type === "finish") finished = event.reason === "stop" || event.reason === "length"
    }
    signal.throwIfAborted()
    // A reasoning model may spend the entire probe thinking. A bounded, finished reasoning
    // response still proves generation works; neither a particular answer nor a completed
    // thought is required.
    if (!generated) throw new Error("The server produced no text or reasoning.")
    if (!finished) throw new Error("The server did not finish the generation response.")
  } catch (error) {
    options.signal.throwIfAborted()
    if (timeout.aborted)
      throw new Error("The local model loaded, but its generation check timed out.")
    throw new Error(
      `The local model loaded, but its generation check failed: ${errorMessage(error)}`,
    )
  } finally {
    await response?.body?.cancel().catch(() => {})
  }
}

async function extractTarGz(archivePath: string, destination: string) {
  await mkdir(destination, { recursive: true })
  const child = spawn("tar", ["-xzf", archivePath, "-C", destination], { stdio: "pipe" })
  const status = await new Promise<number>((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  )
  if (status !== 0) throw new Error("Could not extract the llama.cpp archive.")
}

async function findNamedFile(root: string, fileName: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
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
    const tag = /^(b\d+|prism-b\d+-[a-f0-9]+)(?:-cuda-\d+\.\d+|-cpu)?$/.exec(entry.name)?.[1]
    return entry.isDirectory() && tag !== undefined && !pinned.has(tag)
  })
  await Promise.allSettled(
    stale.map((entry) => rm(join(binaryRoot, entry.name), { recursive: true, force: true })),
  )
}

async function publishRuntimeBundle(
  candidateDir: string,
  binaryDir: string,
  previousDir: string,
  installed: () => Promise<boolean>,
) {
  try {
    await rename(candidateDir, binaryDir)
    return
  } catch (error) {
    // Another process may have completed the same install first.
    if (await installed()) return
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error
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
      if (!(await installed())) throw error
    }
  } catch (error) {
    if (
      displaced &&
      !(await stat(binaryDir).then(
        () => true,
        () => false,
      ))
    ) {
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
  const suffix = hardware.platform === "darwin" ? /\.dylib$/ : /\.so(?:\.\d+)*$/
  const hasLibrary = (prefix: RegExp) =>
    names.some((name) => prefix.test(name) && suffix.test(name))
  if (!hasLibrary(/^libllama.*\./) || !hasLibrary(/^libggml.*\./)) return false
  if (hardware.backend === "cuda") {
    if (!hardware.cudaVersion || !names.includes("libggml-cuda.so")) return false
    for (const library of cudaRuntimeLibraries(hardware)) {
      if (
        !names.includes(library) ||
        !(await stat(join(bundleDir, library)).catch(() => undefined))?.isFile()
      )
        return false
    }
  }

  try {
    const manifest = JSON.parse(
      await readFile(join(bundleDir, RUNTIME_MANIFEST), "utf8"),
    ) as Record<string, unknown> | null
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      manifest.releaseTag !== releaseTag ||
      manifest.platform !== hardware.platform ||
      manifest.arch !== hardware.arch ||
      manifest.backend !== hardware.backend ||
      (hardware.backend === "cuda" && manifest.cudaVersion !== hardware.cudaVersion)
    ) {
      return false
    }
    if (manifest.version === 1) return hardware.backend !== "cuda"
    return manifest.version === 2 && manifest.artifactSha256 === artifactSha256
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

async function listRuntimeDevices(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const result = await execFileAsync(binaryPath, ["--list-devices"], {
    env,
    signal,
    timeout: 15_000,
    maxBuffer: 1024 ** 2,
  })
  return result.stdout
}

async function processCommand(pid: number) {
  try {
    return (await execFileAsync("ps", ["-o", "args=", "-p", String(pid)])).stdout.trim()
  } catch {
    return ""
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals | 0) {
  process.kill(pid, signal)
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

function processHasTerminated(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode != null
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

function unavailableError(fit: LocalModelFit) {
  const gigabytes = Math.max(1, Math.round(fit.memoryRequiredBytes / 1024 ** 3))
  return new Error(`${fit.model.displayName} needs ${gigabytes} GB to run on this machine.`)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function isNotFound(error: unknown) {
  return errorCode(error) === "ENOENT"
}
