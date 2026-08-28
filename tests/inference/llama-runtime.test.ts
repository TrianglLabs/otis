import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { localGgufPath } from "../../src/inference/gguf-cache.js"
import { type HardwareProbe, inferenceMemoryBudget } from "../../src/inference/hardware.js"
import { LlamaCppRuntime, type LlamaCppRuntimeOptions } from "../../src/inference/llama-runtime.js"
import { findLocalModel, type LocalModelSpec } from "../../src/inference/local-catalog.js"
import { fitLocalModel } from "../../src/inference/local-fit.js"

const hardware: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: 64 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
}

const pinnedArchiveURL =
  "https://github.com/ggml-org/llama.cpp/releases/download/b10666/llama-b10666-bin-macos-arm64.tar.gz"
const archiveBody = Buffer.from("archive")
const fakeRuntimeAsset: NonNullable<LlamaCppRuntimeOptions["runtimeAsset"]> = () => ({
  name: "llama-b10666-bin-macos-arm64.tar.gz",
  url: pinnedArchiveURL,
  size: archiveBody.byteLength,
  sha256: createHash("sha256").update(archiveBody).digest("hex"),
})

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("llama.cpp runtime", () => {
  it("installs the complete llama.cpp runtime bundle beside llama-server", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const commands: string[] = []
    const runtime = new LlamaCppRuntime({
      env: {},
      runtimeAsset: fakeRuntimeAsset,
      dataDirectory: directory,
      allocatePort: async () => 18764,
      spawn: ((command) => {
        commands.push(String(command))
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === pinnedArchiveURL) return new Response(archiveBody)
        if (url.includes("/health")) return new Response("ok")
        if (url.includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
      extractArchive: async (_archive, destination) => {
        const bundle = join(destination, "build", "bin")
        await mkdir(bundle, { recursive: true })
        await writeFile(join(bundle, "llama-server"), "server")
        await writeFile(join(bundle, "libllama.dylib"), "llama library")
        await writeFile(join(bundle, "libggml.dylib"), "ggml library")
        await writeFile(join(bundle, "ggml-metal.metal"), "metal backend")
      },
    })

    await runtime.ensureServing(model, fit, hardware)

    const binary = commands[0]
    expect(binary).toBe(join(directory, "bin", "b10666", "llama-server"))
    expect(await readFile(join(dirname(binary as string), "libllama.dylib"), "utf8")).toBe("llama library")
    await expect(readFile(join(dirname(binary as string), ".otis-runtime.json"), "utf8")).resolves.toContain(
      `"artifactSha256":"${fakeRuntimeAsset(hardware).sha256}"`,
    )
    expect(await readFile(join(dirname(binary as string), "ggml-metal.metal"), "utf8")).toBe("metal backend")
    await runtime.stop()
  })

  it("uses only the pinned cached llama.cpp release without querying GitHub", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    await installFakeBinary(directory, "b10667")
    const pinned = await installFakeBinary(directory, "b10666")
    const urls: string[] = []
    let command = ""
    const runtime = new LlamaCppRuntime({
      env: {},
      runtimeAsset: fakeRuntimeAsset,
      dataDirectory: directory,
      allocatePort: async () => 18763,
      spawn: ((nextCommand) => {
        command = String(nextCommand)
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.includes("/health")) return new Response("ok")
        if (url.includes("/props")) return runtimeProperties(fit.contextLength)
        throw new Error("network unavailable")
      }) as typeof fetch,
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(command).toBe(pinned)
    expect(urls).not.toContain(pinnedArchiveURL)
    await expect(stat(join(directory, "bin", "b10667"))).rejects.toMatchObject({ code: "ENOENT" })
    await runtime.stop()
  })

  it("replaces a cached bundle whose manifest does not match the pinned release", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const binary = await installFakeBinary(directory, "b10666")
    await writeFile(
      join(dirname(binary), ".otis-runtime.json"),
      JSON.stringify({
        version: 1,
        releaseTag: "b10621",
        platform: hardware.platform,
        arch: hardware.arch,
        backend: hardware.backend,
      }),
    )
    const urls: string[] = []
    const runtime = new LlamaCppRuntime({
      env: {},
      runtimeAsset: fakeRuntimeAsset,
      dataDirectory: directory,
      allocatePort: async () => 18760,
      spawn: ((_command, _args) => fakeChild()) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url === pinnedArchiveURL) return new Response(archiveBody)
        if (url.includes("/health")) return new Response("ok")
        if (url.includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
      extractArchive: async (_archive, destination) => {
        const bundle = join(destination, "bin")
        await mkdir(bundle, { recursive: true })
        await writeFile(join(bundle, "llama-server"), "replacement server")
        await writeFile(join(bundle, "libllama.dylib"), "llama library")
        await writeFile(join(bundle, "libggml.dylib"), "ggml library")
      },
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(urls).toContain(pinnedArchiveURL)
    expect(await readFile(binary, "utf8")).toBe("replacement server")
    await runtime.stop()
  })

  it("replaces a legacy cache containing only llama-server with a complete bundle", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const binary = await installLoneBinary(directory, "b10666")
    const urls: string[] = []
    const runtime = new LlamaCppRuntime({
      env: {},
      runtimeAsset: fakeRuntimeAsset,
      dataDirectory: directory,
      allocatePort: async () => 18762,
      spawn: ((_command, _args) => fakeChild()) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url === pinnedArchiveURL) return new Response(archiveBody)
        if (url.includes("/health")) return new Response("ok")
        if (url.includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
      extractArchive: async (_archive, destination) => {
        const bundle = join(destination, "bin")
        await mkdir(bundle, { recursive: true })
        await writeFile(join(bundle, "llama-server"), "replacement server")
        await writeFile(join(bundle, "libllama.dylib"), "llama library")
        await writeFile(join(bundle, "libggml.dylib"), "ggml library")
      },
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(urls).toContain(pinnedArchiveURL)
    expect(await readFile(binary, "utf8")).toBe("replacement server")
    expect(await readFile(join(dirname(binary), "libllama.dylib"), "utf8")).toBe("llama library")
    await runtime.stop()
  })

  it("downloads the GGUF then starts llama-server with a local model path", async () => {
    const catalog = findLocalModel("openai/gpt-oss-20b")
    if (!catalog) throw new Error("missing catalog entry")
    const spawned: string[][] = []
    const progress: Array<{ phase: string; percent?: number }> = []
    const child = fakeChild()
    const directory = await tempDir()
    const weights = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(catalog, weights)
    const fit = fitLocalModel(model, hardware)
    const fittedContext = 32_768
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18765,
      readyTimeoutMs: 1_000,
      sleep: async () => undefined,
      spawn: ((command, args) => {
        spawned.push([String(command), ...(args as string[])])
        return child
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: huggingfaceFetch(weights, fittedContext),
    })

    const serving = await runtime.ensureServing(model, fit, hardware, {
      onProgress: (event) => progress.push(event),
    })
    expect(serving.inferenceURL).toBe("http://127.0.0.1:18765/v1/chat/completions")
    expect(serving.contextLength).toBe(fittedContext)
    expect(spawned[0]?.slice(1)).toEqual(
      expect.arrayContaining([
        "--model",
        localGgufPath(model, directory),
        "--jinja",
        "--host",
        "127.0.0.1",
        "--no-webui",
        "--parallel",
        "1",
        "--fit",
        "on",
        "--fit-target",
        String(inferenceMemoryBudget(hardware).deviceHeadroomBytes / 1024 ** 2),
        "--fit-ctx",
        "8192",
      ]),
    )
    expect(spawned[0]).not.toContain("--ctx-size")
    expect(spawned[0]).not.toContain("--n-gpu-layers")
    expect((await runtime.ensureServing(model, { ...fit, contextLength: fittedContext }, hardware)).contextLength).toBe(
      fittedContext,
    )
    expect(spawned).toHaveLength(1)
    expect(progress).toEqual(expect.arrayContaining([{ phase: "download", percent: 100 }, { phase: "loading" }]))
    await runtime.stop()
  })

  it("isolates llama.cpp arguments from the parent environment", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    let childEnv: NodeJS.ProcessEnv | undefined
    const runtime = new LlamaCppRuntime({
      env: {
        OTIS_LLAMA_SERVER: process.execPath,
        PATH: "/usr/bin",
        LLAMA_ARG_CTX_SIZE: "262144",
        LLAMA_ARG_FIT_TARGET: "0",
        LLAMA_ARG_SPEC_TYPE: "draft-mtp",
      },
      dataDirectory: directory,
      allocatePort: async () => 18761,
      spawn: ((_command, _args, options) => {
        childEnv = options?.env
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("ok")
      }) as typeof fetch,
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(childEnv).toMatchObject({ PATH: "/usr/bin", LLAMA_CACHE: join(directory, "models") })
    expect(Object.keys(childEnv ?? {}).some((name) => name.startsWith("LLAMA_ARG_"))).toBe(false)
    await runtime.stop()
  })

  it("reuses an on-disk GGUF instead of downloading again", async () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const urls: string[] = []
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18766,
      readyTimeoutMs: 1_000,
      sleep: async () => undefined,
      spawn: ((_command, _args) => fakeChild()) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        if (String(input).includes("/health")) return new Response("ok", { status: 200 })
        if (String(input).includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
    })

    await runtime.ensureServing(model, fit, hardware)
    expect(urls.some((url) => url.includes("huggingface.co"))).toBe(false)
    await runtime.stop()
  })

  it("waits for llama-server to exit before stop resolves", async () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const child = fakeChild()
    child.kill = () => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit("exit", 0)
      })
      return true
    }
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18767,
      readyTimeoutMs: 1_000,
      sleep: async () => {
        await Promise.resolve()
      },
      spawn: ((_command, _args) => child) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes("/health")) return new Response("ok", { status: 200 })
        if (String(input).includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
    })

    await runtime.ensureServing(model, fit, hardware)
    expect(child.exitCode).toBeNull()
    await runtime.stop()
    expect(child.exitCode).toBe(0)
  })

  it("reports a signal-terminated server immediately while waiting for readiness", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const child = fakeChild()
    child.kill = vi.fn(() => true)
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18768,
      readyTimeoutMs: 60_000,
      sleep: async () => {
        child.signalCode = "SIGKILL"
      },
      spawn: ((_command, _args) => child) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async () => new Response("loading", { status: 503 })) as typeof fetch,
    })

    await expect(runtime.ensureServing(model, fit, hardware)).rejects.toThrow("signal SIGKILL")
    expect(child.kill).not.toHaveBeenCalled()
  })

  it("does not signal a process that has already exited by signal", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const child = fakeChild()
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18769,
      spawn: ((_command, _args) => child) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("ok")
      }) as typeof fetch,
    })
    await runtime.ensureServing(model, fit, hardware)
    child.signalCode = "SIGKILL"
    child.kill = vi.fn(() => true)

    await runtime.stop()

    expect(child.kill).not.toHaveBeenCalled()
  })

  it("refuses to start a model that will not fit", async () => {
    const model = findLocalModel("Qwen/Qwen3.8-27B")
    if (!model) throw new Error("missing catalog entry")
    const tight: HardwareProbe = { ...hardware, totalMemoryBytes: 8 * 1024 ** 3, gpuMemoryBytes: 8 * 1024 ** 3 }
    const runtime = new LlamaCppRuntime({ env: { OTIS_LLAMA_SERVER: process.execPath } })
    await expect(runtime.ensureServing(model, fitLocalModel(model, tight), tight)).rejects.toThrow("needs")
  })

  it("rejects unsupported platforms before resolving or spawning a runtime", async () => {
    const model = catalogModel()
    const unsupported: HardwareProbe = {
      ...hardware,
      platform: "win32",
      arch: "x64",
      backend: "cpu",
      unifiedMemory: false,
    }
    const spawnRuntime = vi.fn()
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
    })

    await expect(runtime.ensureServing(model, fitLocalModel(model, unsupported), unsupported)).rejects.toThrow(
      "Local inference is not supported on win32/x64.",
    )
    expect(spawnRuntime).not.toHaveBeenCalled()
  })

  it("does not spawn a superseded start after asynchronous port allocation", async () => {
    const firstModel = catalogModel()
    const secondModel = findLocalModel("Qwen/Qwen3.8-27B")
    if (!secondModel) throw new Error("missing catalog entry")
    const directory = await tempDir()
    await cacheWeights(firstModel, directory)
    await cacheWeights(secondModel, directory)
    let releaseFirstPort: ((port: number) => void) | undefined
    let firstPortStarted: (() => void) | undefined
    const portStarted = new Promise<void>((resolve) => {
      firstPortStarted = resolve
    })
    let allocation = 0
    const spawnRuntime = vi.fn(() => fakeChild())
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => {
        allocation += 1
        if (allocation > 1) return 18771
        firstPortStarted?.()
        return await new Promise<number>((resolve) => {
          releaseFirstPort = resolve
        })
      },
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes("/props")) return runtimeProperties(32_768)
        return new Response("ok")
      }) as typeof fetch,
    })

    const first = runtime.ensureServing(firstModel, fitLocalModel(firstModel, hardware), hardware)
    await portStarted
    const second = runtime.ensureServing(secondModel, fitLocalModel(secondModel, hardware), hardware)
    await second
    releaseFirstPort?.(18770)

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    expect(spawnRuntime).toHaveBeenCalledTimes(1)
    expect(runtime.serving?.model).toBe(secondModel.id)
    await runtime.stop()
  })

  it("keeps the final 20 KB of startup logs across chunk boundaries", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const child = fakeChild()
    let emitted = false
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18772,
      spawn: (() => child) as unknown as LlamaCppRuntimeOptions["spawn"],
      fetch: (async () => new Response("loading", { status: 503 })) as typeof fetch,
      sleep: async () => {
        if (emitted) return
        emitted = true
        child.stderr.emit("data", `${"x".repeat(14_000)}FIRST-TAIL`)
        child.stderr.emit("data", "y".repeat(5_000))
        child.stderr.emit("data", `${"z".repeat(5_000)}FINAL`)
        child.exitCode = 1
      },
    })

    await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(
      /FIRST-TAIL[\s\S]*FINAL/,
    )
  })

  it("rejects a llama.cpp archive whose checksum does not match the pin", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const spawnRuntime = vi.fn()
    const extractArchive = vi.fn()
    const runtime = new LlamaCppRuntime({
      env: {},
      dataDirectory: directory,
      runtimeAsset: () => ({ ...fakeRuntimeAsset(hardware), sha256: "0".repeat(64) }),
      spawn: spawnRuntime as LlamaCppRuntimeOptions["spawn"],
      extractArchive,
      fetch: (async () => new Response(archiveBody)) as typeof fetch,
    })

    await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(
      "SHA-256 verification failed",
    )
    expect(extractArchive).not.toHaveBeenCalled()
    expect(spawnRuntime).not.toHaveBeenCalled()
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-llama-"))
  tempDirectories.push(path)
  return path
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal?: string) => boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.exitCode = 0
    child.emit("exit", 0)
    return true
  }
  return child
}

function catalogModel() {
  const model = findLocalModel("openai/gpt-oss-20b")
  if (!model) throw new Error("missing catalog entry")
  return model
}

async function cacheWeights(model: ReturnType<typeof catalogModel>, directory: string) {
  await mkdir(join(directory, "models"), { recursive: true })
  const path = localGgufPath(model, directory)
  await writeFile(path, "")
  await truncate(path, model.ggufFiles[0].size)
  await writeFile(
    `${path}.otis.json`,
    JSON.stringify({
      version: 1,
      model: model.id,
      revision: model.ggufRevision,
      sha256: model.ggufFiles[0].sha256,
      size: model.ggufFiles[0].size,
    }),
  )
}

function tinyModel(model: ReturnType<typeof catalogModel>, contents: Uint8Array): LocalModelSpec {
  return {
    ...model,
    ggufFiles: [
      {
        name: "tiny.gguf",
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    ],
  }
}

async function installFakeBinary(directory: string, release: string) {
  const binary = await installLoneBinary(directory, release)
  await writeFile(join(dirname(binary), "libllama.dylib"), "llama library")
  await writeFile(join(dirname(binary), "libggml.dylib"), "ggml library")
  return binary
}

async function installLoneBinary(directory: string, release: string) {
  const binary = join(directory, "bin", release, "llama-server")
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(binary, "server")
  await chmod(binary, 0o755)
  return binary
}

function huggingfaceFetch(body: Uint8Array, contextLength: number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/health")) return new Response("ok", { status: 200 })
    if (url.includes("/props")) return runtimeProperties(contextLength)
    if (url.includes("huggingface.co")) {
      return new Response(Buffer.from(body), { status: 200, headers: { "content-length": String(body.byteLength) } })
    }
    return new Response("missing", { status: 404 })
  }) as typeof fetch
}

function runtimeProperties(contextLength: number) {
  return Response.json({ default_generation_settings: { n_ctx: contextLength } })
}
