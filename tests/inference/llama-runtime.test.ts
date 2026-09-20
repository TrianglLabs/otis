import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { localGgufPath } from "../../src/inference/gguf-cache.js"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import {
  LLAMA_CPP_RELEASE_TAG,
  type LlamaRuntimeKind,
  llamaRuntimeReleaseTag,
  PRISM_LLAMA_CPP_RELEASE_TAG,
  pinnedLlamaCppAsset,
} from "../../src/inference/llama-binary.js"
import {
  formatLocalLoadStatus,
  LlamaCppRuntime,
  type LlamaCppRuntimeOptions,
} from "../../src/inference/llama-runtime.js"
import { findLocalModel, type LocalModelSpec } from "../../src/inference/local-catalog.js"
import { fitLocalModel } from "../../src/inference/local-fit.js"

const hardware: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: 64 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
  gpuCount: 1,
}

const pinnedAsset = pinnedLlamaCppAsset(hardware)
const pinnedArchiveURL = pinnedAsset.url
const archiveBody = Buffer.from("archive")
const fakeRuntimeAsset: NonNullable<LlamaCppRuntimeOptions["runtimeAsset"]> = () => ({
  name: pinnedAsset.name,
  url: pinnedArchiveURL,
  size: archiveBody.byteLength,
  sha256: createHash("sha256").update(archiveBody).digest("hex"),
})

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("llama.cpp runtime", () => {
  it("labels the runtime download separately from model weights", () => {
    expect(formatLocalLoadStatus({ phase: "runtime-download" })).toBe("Downloading llama.cpp")
  })

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
    expect(binary).toBe(join(directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server"))
    expect(await readFile(join(dirname(binary as string), "libllama.dylib"), "utf8")).toBe("llama library")
    await expect(readFile(join(dirname(binary as string), ".otis-runtime.json"), "utf8")).resolves.toContain(
      `"artifactSha256":"${fakeRuntimeAsset(hardware, "upstream").sha256}"`,
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
    const pinned = await installFakeBinary(directory, LLAMA_CPP_RELEASE_TAG)
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

  it("uses the pinned Prism runtime only for Bonsai and preserves the upstream bundle", async () => {
    const model = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!model) throw new Error("missing Bonsai catalog entry")
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(fit.model, directory)
    const upstream = await installFakeBinary(directory, LLAMA_CPP_RELEASE_TAG)
    const prismArchiveURL =
      "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10685-7dffb15/test-prism.tar.gz"
    const selectedRuntimes: string[] = []
    let command = ""
    const runtime = new LlamaCppRuntime({
      env: {},
      runtimeAsset: (_target, selectedRuntime) => {
        selectedRuntimes.push(selectedRuntime)
        return {
          name: "test-prism.tar.gz",
          url: prismArchiveURL,
          size: archiveBody.byteLength,
          sha256: createHash("sha256").update(archiveBody).digest("hex"),
        }
      },
      dataDirectory: directory,
      allocatePort: async () => 18774,
      spawn: ((nextCommand) => {
        command = String(nextCommand)
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === prismArchiveURL) return new Response(archiveBody)
        if (url.includes("/health")) return new Response("ok")
        if (url.includes("/props")) return runtimeProperties(fit.contextLength)
        return new Response("missing", { status: 404 })
      }) as typeof fetch,
      extractArchive: async (_archive, destination) => {
        const bundle = join(destination, "bin")
        await mkdir(bundle, { recursive: true })
        await writeFile(join(bundle, "llama-server"), "prism server")
        await writeFile(join(bundle, "libllama.dylib"), "llama library")
        await writeFile(join(bundle, "libggml.dylib"), "ggml library")
      },
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(selectedRuntimes).toEqual(["prism"])
    expect(command).toBe(join(directory, "bin", "prism-b10685-7dffb15", "llama-server"))
    await expect(stat(upstream)).resolves.toBeDefined()
    await runtime.stop()
  })

  it.each([
    "packing",
    "revision",
    "checksum",
  ] as const)("restarts the same model when its %s changes", async (change) => {
    const first = tinyModel(catalogModel(), new Uint8Array([1, 2, 3, 4]))
    const second: LocalModelSpec = {
      ...first,
      ...(change === "packing"
        ? {
            quant: "different-packing",
            ggufFiles: [{ ...first.ggufFiles[0], name: "other.gguf" }],
          }
        : {}),
      ...(change === "revision" ? { ggufRevision: "a".repeat(40) } : {}),
      ...(change === "checksum" ? { ggufFiles: [{ ...first.ggufFiles[0], sha256: "a".repeat(64) }] } : {}),
    }
    const directory = await tempDir()
    await cacheWeights(first, directory)
    const children: ReturnType<typeof fakeChild>[] = []
    const spawnedPaths: string[] = []
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18775,
      spawn: ((_command, args) => {
        const child = fakeChild()
        children.push(child)
        if (!Array.isArray(args)) throw new Error("Expected llama-server arguments")
        const modelIndex = args.indexOf("--model")
        spawnedPaths.push(String(args[modelIndex + 1]))
        return child
      }) as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input) => {
        if (String(input).endsWith("/props")) return runtimeProperties(65_536)
        if (String(input).endsWith("/health")) return new Response("ok")
        throw new Error("Unexpected download")
      }) as typeof fetch,
    })
    try {
      await runtime.ensureServing(first, fitLocalModel(first, hardware), hardware)
      await runtime.ensureServing(first, fitLocalModel(first, hardware), hardware)
      expect(children).toHaveLength(1)

      await cacheWeights(second, directory)
      await runtime.ensureServing(second, fitLocalModel(second, hardware), hardware)
      expect(children).toHaveLength(2)
      expect(children[0]?.exitCode).toBe(0)
      expect(spawnedPaths).toEqual([localGgufPath(first, directory), localGgufPath(second, directory)])
    } finally {
      await runtime.stop()
    }
  })

  it("reports the runtime phase and retries a transient gateway failure", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    let downloads = 0
    const delays: number[] = []
    const progress: Parameters<typeof formatLocalLoadStatus>[0][] = []
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(
        directory,
        async (input) => {
          const url = String(input)
          if (url === pinnedArchiveURL) {
            downloads += 1
            if (downloads === 1) {
              return new Response("gateway timeout", { status: 504, headers: { "retry-after": "2" } })
            }
            if (downloads === 2) throw new TypeError("connection reset")
            return new Response(archiveBody)
          }
          if (url.includes("/health")) return new Response("ok")
          if (url.includes("/props")) return runtimeProperties(65_536)
          return new Response("missing", { status: 404 })
        },
        { sleep: async (ms) => void delays.push(ms) },
      ),
    )

    await runtime.ensureServing(model, fitLocalModel(model, hardware), hardware, {
      onProgress: (event) => progress.push(event),
    })

    expect(downloads).toBe(3)
    expect(delays).toEqual([2_000, 1_000])
    expect(progress[0]).toEqual({ phase: "runtime-download" })
    await runtime.stop()
  })

  it("does not retry a permanent runtime download response", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const fetchRuntime = vi.fn(async () => new Response("missing", { status: 404 }))
    const retry = vi.fn(async () => {})
    const runtime = new LlamaCppRuntime(runtimeDownloadOptions(directory, fetchRuntime, { sleep: retry }))

    await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(
      "Could not download llama.cpp (HTTP 404).",
    )
    expect(fetchRuntime).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
  })

  it("finishes a steadily progressing download that takes longer than the inactivity limit", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    let downloads = 0
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(
        directory,
        async (input, init) => {
          if (String(input).includes("/health")) return new Response("ok")
          if (String(input).includes("/props")) return runtimeProperties(65_536)
          downloads += 1
          const signal = init?.signal
          if (!signal) throw new Error("missing request signal")
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              let offset = 0
              const timer = setInterval(() => {
                controller.enqueue(archiveBody.subarray(offset, ++offset))
                if (offset === archiveBody.length) {
                  clearInterval(timer)
                  signal.removeEventListener("abort", abort)
                  controller.close()
                }
              }, 100)
              const abort = () => {
                clearInterval(timer)
                controller.error(signal.reason)
              }
              signal.addEventListener("abort", abort, { once: true })
            },
          })
          return new Response(body)
        },
        { runtimeDownloadTimeoutMs: 500, sleep: async () => {} },
      ),
    )

    try {
      const endpoint = await runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)
      expect(endpoint.model).toBe(model.id)
      expect(downloads).toBe(1)
    } finally {
      await runtime.stop()
    }
  })

  it.each([
    { status: 504, attempts: 3, message: "HTTP 504" },
    { status: 404, attempts: 1, message: "HTTP 404" },
    { status: 200, contentLength: "invalid", attempts: 3, message: "invalid content length" },
    { status: 200, contentLength: "100", attempts: 3, message: "expected 7 bytes but received 100" },
    { status: 200, attempts: 3, message: "exceeded the pinned artifact size" },
  ])("closes rejected runtime responses before retrying ($message)", async ({
    status,
    contentLength,
    attempts,
    message,
  }) => {
    const model = catalogModel()
    const directory = await tempDir()
    const responses: { response: Response; signal: AbortSignal; cancel: ReturnType<typeof vi.fn> }[] = []
    const assertClosed = () => {
      for (const { response, signal, cancel } of responses) {
        expect(signal.aborted).toBe(true)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(response.body?.locked).toBe(false)
      }
    }
    const fetchRuntime = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      assertClosed()
      const signal = init?.signal
      if (!signal) throw new Error("missing request signal")
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("oversized archive"))
        },
        cancel,
      })
      const response = new Response(body, {
        status,
        headers: contentLength === undefined ? undefined : { "content-length": contentLength },
      })
      responses.push({ response, signal, cancel })
      return response
    })
    const extractArchive = vi.fn()
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(directory, fetchRuntime, { sleep: async () => {}, extractArchive }),
    )

    try {
      await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(message)
      expect(fetchRuntime).toHaveBeenCalledTimes(attempts)
      expect(extractArchive).not.toHaveBeenCalled()
      assertClosed()
    } finally {
      await runtime.stop()
      for (const { response } of responses) {
        if (!response.body?.locked) await response.body?.cancel()
      }
    }
  })

  it("bounds a stalled runtime download and retries it", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const fetchRuntime = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) throw new Error("missing request signal")
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    )
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(directory, fetchRuntime, {
        runtimeDownloadAttempts: 2,
        runtimeDownloadTimeoutMs: 5,
        sleep: async () => {},
      }),
    )

    await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(
      "Could not download llama.cpp: the request timed out.",
    )
    expect(fetchRuntime).toHaveBeenCalledTimes(2)
  })

  it.each([
    "timeout",
    "cancel",
  ] as const)("handles %s after the response body stops delivering bytes", async (action) => {
    const model = catalogModel()
    const directory = await tempDir()
    const abort = new AbortController()
    const responses: { response: Response; signal: AbortSignal }[] = []
    let reading: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve
    })
    const fetchRuntime = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error("missing request signal")
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(archiveBody.subarray(0, 1))
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
          },
          pull() {
            reading()
          },
        }),
      )
      responses.push({ response, signal })
      return response
    })
    const extractArchive = vi.fn()
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(directory, fetchRuntime, {
        runtimeDownloadAttempts: 2,
        runtimeDownloadTimeoutMs: 200,
        sleep: async () => {},
        extractArchive,
      }),
    )

    try {
      const pending = runtime.ensureServing(model, fitLocalModel(model, hardware), hardware, { signal: abort.signal })
      const result =
        action === "cancel"
          ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
          : expect(pending).rejects.toThrow("Could not download llama.cpp: the request timed out.")
      if (action === "cancel") {
        await readStarted
        abort.abort()
      }
      await result
      expect(fetchRuntime).toHaveBeenCalledTimes(action === "cancel" ? 1 : 2)
      expect(extractArchive).not.toHaveBeenCalled()
      for (const { response, signal } of responses) {
        expect(signal.aborted).toBe(true)
        expect(response.body?.locked).toBe(false)
      }
    } finally {
      await runtime.stop()
    }
  })

  it("cancels immediately during runtime download backoff", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const abort = new AbortController()
    let closed: () => void = () => {}
    const responseClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const fetchRuntime = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              closed()
            },
          }),
          { status: 504, headers: { "retry-after": "30" } },
        ),
    )
    const runtime = new LlamaCppRuntime(runtimeDownloadOptions(directory, fetchRuntime))

    try {
      const result = expect(
        runtime.ensureServing(model, fitLocalModel(model, hardware), hardware, {
          signal: abort.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" })
      await responseClosed
      // Let the failed attempt enter its real 30-second backoff before cancelling it.
      await new Promise((resolve) => setTimeout(resolve, 0))
      abort.abort()
      await result
      expect(fetchRuntime).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.stop()
    }
  })

  it("replaces a cached bundle whose manifest does not match the pinned release", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const binary = await installFakeBinary(directory, LLAMA_CPP_RELEASE_TAG)
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
    const binary = await installLoneBinary(directory, LLAMA_CPP_RELEASE_TAG)
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

  it.each([
    ["unified memory", hardware, 9831],
    [
      "two GPUs",
      {
        ...hardware,
        platform: "linux",
        arch: "x64",
        backend: "vulkan",
        unifiedMemory: false,
        gpuCount: 2,
        gpuMemoryBytes: 32 * 1024 ** 3,
      },
      1024,
    ],
    [
      "unknown VRAM",
      {
        ...hardware,
        platform: "linux",
        arch: "x64",
        backend: "vulkan",
        unifiedMemory: false,
        totalMemoryBytes: 128 * 1024 ** 3,
        gpuCount: 1,
        gpuMemoryBytes: undefined,
      },
      1024,
    ],
    [
      "CPU",
      {
        ...hardware,
        platform: "linux",
        arch: "x64",
        backend: "cpu",
        unifiedMemory: false,
        gpuCount: 0,
        gpuMemoryBytes: undefined,
      },
      6554,
    ],
  ] as const)("downloads the GGUF and passes the per-device margin for %s", async (_label, hardware, targetMiB) => {
    const catalog = findLocalModel("openai/gpt-oss-20b")
    if (!catalog) throw new Error("missing catalog entry")
    const spawned: string[][] = []
    const progress: Array<{ phase: string; percent?: number }> = []
    const child = fakeChild()
    const directory = await tempDir()
    const weights = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(catalog, weights)
    const fit = fitLocalModel(model, hardware)
    const fittedContext = 65_536
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
        String(targetMiB),
        "--fit-ctx",
        "65536",
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
      gpuCount: 1,
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
        if (String(input).includes("/props")) return runtimeProperties(65_536)
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
      runtimeAsset: () => ({ ...fakeRuntimeAsset(hardware, "upstream"), sha256: "0".repeat(64) }),
      spawn: spawnRuntime as LlamaCppRuntimeOptions["spawn"],
      extractArchive,
      fetch: (async () => new Response(archiveBody)) as typeof fetch,
      sleep: async () => {},
    })

    await expect(runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)).rejects.toThrow(
      "SHA-256 verification failed",
    )
    expect(extractArchive).not.toHaveBeenCalled()
    expect(spawnRuntime).not.toHaveBeenCalled()
  })
})

describe("CUDA runtime bundles", () => {
  it.each([
    "12.8",
    "13.3",
  ] as const)("isolates CUDA %s libraries for both device checks and serving without changing the parent", async (cudaVersion) => {
    const setup = await cudaRuntimeSetup(cudaVersion)
    const parent = Object.freeze({
      PATH: "/usr/bin:/opt/cuda/bin",
      LD_LIBRARY_PATH: "/opt/other-cuda/lib64:/usr/lib/wsl/lib;/opt/nvidia/lib",
      LD_PRELOAD: "/opt/other-cuda/lib64/libcudart.so",
      LD_AUDIT: "/opt/audit.so",
      GGML_BACKEND_PATH: "/opt/other-llama/libggml-cuda.so",
      CUDA_VISIBLE_DEVICES: "1",
      CUDA_HOME: "/opt/other-cuda",
      FIREWORKS_API_KEY: "not-for-the-server",
      LLAMA_ARG_DEVICE: "CPU",
    })
    const before = { ...parent }
    const environments: NodeJS.ProcessEnv[] = []
    const listDevices = setup.options.listDevices as NonNullable<LlamaCppRuntimeOptions["listDevices"]>
    setup.options.listDevices = async (path, env, signal) => {
      environments.push(env)
      return await listDevices(path, env, signal)
    }
    const spawnRuntime = vi.fn((_command, args, options) => {
      environments.push(options.env)
      expect(args.slice(-2)).toEqual(["--device", "CUDA0"])
      return fakeChild()
    })
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      env: parent,
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(environments).toHaveLength(2)
    for (const env of environments) {
      expect(env).toMatchObject({
        LD_LIBRARY_PATH: `${setup.cudaDir}:/opt/other-cuda/lib64:/usr/lib/wsl/lib:/opt/nvidia/lib`,
        PATH: parent.PATH,
        CUDA_HOME: parent.CUDA_HOME,
        CUDA_VISIBLE_DEVICES: "1",
      })
      for (const name of ["LD_PRELOAD", "LD_AUDIT", "GGML_BACKEND_PATH", "FIREWORKS_API_KEY", "LLAMA_ARG_DEVICE"]) {
        expect(env[name]).toBeUndefined()
      }
    }
    expect(parent).toEqual(before)
    await runtime.stop()
  })

  it.each([undefined, "", ":;"])("uses only the bundle when the inherited library path is %s", async (libraryPath) => {
    const setup = await cudaRuntimeSetup()
    let childEnv: NodeJS.ProcessEnv | undefined
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      env: { LD_LIBRARY_PATH: libraryPath },
      spawn: ((_command, _args, options) => {
        childEnv = options?.env
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(childEnv?.LD_LIBRARY_PATH).toBe(setup.cudaDir)
    await runtime.stop()
  })

  it("preserves loader settings and skips automatic backend selection for a custom server", async () => {
    const setup = await cudaRuntimeSetup()
    const env = Object.freeze({
      OTIS_LLAMA_SERVER: process.execPath,
      LD_LIBRARY_PATH: "/custom/cuda/lib",
      LD_PRELOAD: "/custom/preload.so",
      LD_AUDIT: "/custom/audit.so",
      GGML_BACKEND_PATH: "/custom/backend.so",
    })
    const listDevices = vi.fn()
    let childEnv: NodeJS.ProcessEnv | undefined
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      env,
      listDevices,
      spawn: ((_command, args, options) => {
        childEnv = options?.env
        expect(args).not.toContain("--device")
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(childEnv).toMatchObject(env)
    expect(listDevices).not.toHaveBeenCalled()
    expect(setup.downloads).toEqual([])
    await runtime.stop()
  })

  it.each([
    "CUDA error: no kernel image is available for execution on the device",
    "ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory",
    "llama-server: libcublas.so.13: cannot open shared object file",
    "error: invalid device: CUDA0",
  ])("retries once with verified Vulkan after CUDA startup exits with %s", async (diagnostic) => {
    const setup = await cudaRuntimeSetup()
    setup.options.env = { LD_LIBRARY_PATH: "/opt/cuda-other/lib:/usr/lib/wsl/lib" }
    const children: ReturnType<typeof fakeChild>[] = []
    const paths: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: ((command, args, options) => {
        const child = fakeChild()
        children.push(child)
        paths.push(String(command))
        const cuda = children.length === 1
        expect(args?.slice(-2)).toEqual(["--device", cuda ? "CUDA0" : "Vulkan0"])
        expect(options?.env?.LD_LIBRARY_PATH).toBe(`${dirname(String(command))}:/opt/cuda-other/lib:/usr/lib/wsl/lib`)
        if (cuda)
          queueMicrotask(() => {
            child.stderr.emit("data", diagnostic)
            child.exitCode = 1
            child.emit("exit", 1)
          })
        else expect(children[0]?.exitCode).toBe(1)
        return child
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(paths).toEqual([
      join(setup.cudaDir, "llama-server"),
      join(setup.directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server"),
    ])
    expect(setup.downloads).toEqual([
      "https://runtime.test/cuda",
      "https://runtime.test/cudart",
      "https://runtime.test/vulkan",
    ])
    // Reuse the live fallback process under the original hardware selection.
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(children).toHaveLength(2)
    await runtime.stop()
  })

  it.each([
    "ggml_cuda_init: found 1 CUDA devices\nerror loading model: invalid GGUF tensor",
    "std::bad_alloc",
    "failed to bind to address 127.0.0.1",
  ])("preserves unrelated startup errors without a backend retry: %s", async (diagnostic) => {
    const setup = await cudaRuntimeSetup()
    const spawnRuntime = vi.fn(() => {
      const child = fakeChild()
      queueMicrotask(() => {
        child.stderr.emit("data", diagnostic)
        child.exitCode = 1
        child.emit("exit", 1)
      })
      return child
    })
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(diagnostic)
    expect(spawnRuntime).toHaveBeenCalledOnce()
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("stops after one retry if Vulkan also fails during model loading", async () => {
    const setup = await cudaRuntimeSetup()
    let launches = 0
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: (() => {
        const child = fakeChild()
        const diagnostic = ++launches === 1 ? "CUDA error: initialization error" : "Vulkan device lost"
        queueMicrotask(() => {
          child.stderr.emit("data", diagnostic)
          child.exitCode = 1
          child.emit("exit", 1)
        })
        return child
      }) as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow("Vulkan device lost")
    expect(launches).toBe(2)
    expect(runtime.serving).toBeUndefined()
    await runtime.stop()
  })

  it("does not retry a CUDA startup failure after cancellation", async () => {
    const setup = await cudaRuntimeSetup()
    const abort = new AbortController()
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: (() => {
        const child = fakeChild()
        queueMicrotask(() => {
          child.stderr.emit("data", "CUDA error: initialization error")
          child.exitCode = 1
          child.emit("exit", 1)
          abort.abort()
        })
        return child
      }) as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await expect(
      runtime.ensureServing(setup.model, setup.fit, setup.hardware, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("surfaces process launch errors without retrying a different backend", async () => {
    const setup = await cudaRuntimeSetup()
    const spawnRuntime = vi.fn(() => {
      const child = fakeChild()
      queueMicrotask(() => {
        child.exitCode = -13
        child.emit("error", new Error("spawn EACCES"))
      })
      return child
    })
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow("spawn EACCES")
    expect(spawnRuntime).toHaveBeenCalledOnce()
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("does not treat an invalid context response as a CUDA backend failure", async () => {
    const setup = await cudaRuntimeSetup()
    const fetchRuntime = setup.options.fetch as typeof fetch
    setup.options.fetch = (async (input, init) =>
      String(input).includes("/props") ? runtimeProperties(0) : await fetchRuntime(input, init)) as typeof fetch
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow("valid context size")
    expect(setup.commands).toHaveLength(1)
    expect(setup.downloads).toHaveLength(2)
    expect(runtime.serving).toBeUndefined()
    await runtime.stop()
  })

  it.each([
    "Available devices:\n  (none)",
    "Available devices:\n  CUDA0: NVIDIA RTX",
  ])("refuses an unusable Vulkan fallback instead of silently selecting CPU: %s", async (output) => {
    const setup = await cudaRuntimeSetup()
    const old = await installFakeBinary(setup.directory, "b10964")
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      listDevices: async (path) => (path.includes("-cuda-") ? "Available devices:\n  (none)" : output),
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "Vulkan GPU acceleration is unavailable",
    )
    expect(setup.commands).toEqual([])
    expect(await readFile(old, "utf8")).toBe("server")
    await runtime.stop()
  })

  it.each([
    "12.8",
    "13.3",
  ] as const)("starts Bonsai with Prism CUDA %s and its cached PQ2 weights", async (cudaVersion) => {
    const setup = await cudaRuntimeSetup(cudaVersion, "prism")
    const selectAsset = vi.fn(setup.options.runtimeAsset)
    const runtime = new LlamaCppRuntime({ ...setup.options, runtimeAsset: selectAsset })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.fit.model.quant).toBe("PQ2_0")
    expect(selectAsset).toHaveBeenCalledWith(expect.objectContaining({ backend: "cuda", cudaVersion }), "prism")
    expect(setup.commands).toEqual([
      join(setup.directory, "bin", `${PRISM_LLAMA_CPP_RELEASE_TAG}-cuda-${cudaVersion}`, "llama-server"),
    ])
    expect(setup.downloads).toEqual(["https://runtime.test/cuda", "https://runtime.test/cudart"])
    await runtime.stop()
  })

  it("keeps Bonsai on Prism and reuses cached PTQ1 when CUDA falls back to Vulkan", async () => {
    const setup = await cudaRuntimeSetup("13.3", "prism")
    const fallback = fitLocalModel(setup.model, { ...setup.hardware, backend: "vulkan" }).model
    await cacheWeights(fallback, setup.directory)
    const spawn = vi.fn(setup.options.spawn)
    const selectAsset = vi.fn(setup.options.runtimeAsset)
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      runtimeAsset: selectAsset,
      spawn: spawn as unknown as LlamaCppRuntimeOptions["spawn"],
      listDevices: async (path) =>
        path.includes("-cuda-") ? "Available devices:\n  (none)" : "Available devices:\n  Vulkan0: NVIDIA RTX",
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.fit.model.quant).toBe("PQ2_0")
    expect(spawn.mock.calls[0]?.[1]).toContain(localGgufPath(fallback, setup.directory))
    expect(selectAsset).toHaveBeenLastCalledWith(expect.objectContaining({ backend: "vulkan" }), "prism")
    expect(setup.commands).toEqual([join(setup.directory, "bin", PRISM_LLAMA_CPP_RELEASE_TAG, "llama-server")])
    expect(setup.downloads).toEqual([
      "https://runtime.test/cuda",
      "https://runtime.test/cudart",
      "https://runtime.test/vulkan",
    ])
    await runtime.stop()
  })

  it.each([
    "probe",
    "startup",
  ] as const)("downloads verified PTQ1 after Bonsai CUDA %s failure and reuses the live fallback", async (failure) => {
    const setup = await cudaRuntimeSetup("13.3", "prism")
    const body = Buffer.from("fallback PTQ1 weights")
    const model = {
      ...setup.model,
      packings: setup.model.packings?.map((packing) =>
        packing.quant !== "PTQ1_0"
          ? packing
          : {
              ...packing,
              ggufFiles: [
                { ...packing.ggufFiles[0], size: body.length, sha256: createHash("sha256").update(body).digest("hex") },
              ],
            },
      ) as LocalModelSpec["packings"],
    }
    const fit = fitLocalModel(model, setup.hardware)
    const fallback = fitLocalModel(model, { ...setup.hardware, backend: "vulkan" }).model
    const fallbackPath = localGgufPath(fallback, setup.directory)
    const originalFetch = setup.options.fetch
    if (!originalFetch) throw new Error("missing fake fetch")
    const children: ReturnType<typeof fakeChild>[] = []
    const paths: string[] = []
    const progress: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      listDevices: async (path) =>
        path.includes("-cuda-")
          ? failure === "probe"
            ? "Available devices: (none)"
            : "CUDA0: NVIDIA"
          : "Vulkan0: NVIDIA",
      fetch: (async (input, init) => {
        if (String(input).endsWith(fallback.ggufFiles[0].name)) {
          setup.downloads.push(String(input))
          return new Response(body)
        }
        return await originalFetch(input, init)
      }) as typeof fetch,
      spawn: ((_command: string, args?: readonly string[]) => {
        const child = fakeChild()
        children.push(child)
        paths.push(String(args?.[1]))
        if (failure === "startup" && children.length === 1) {
          queueMicrotask(() => {
            child.stderr.emit("data", "CUDA error: initialization error")
            child.exitCode = 1
            child.emit("exit", 1)
          })
        }
        return child
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    try {
      const endpoint = await runtime.ensureServing(model, fit, setup.hardware, {
        onProgress: ({ phase }) => progress.push(phase),
      })
      expect(paths).toEqual(
        failure === "probe" ? [fallbackPath] : [localGgufPath(model, setup.directory), fallbackPath],
      )
      expect(await readFile(fallbackPath)).toEqual(body)
      expect((await stat(localGgufPath(model, setup.directory))).size).toBe(model.ggufFiles[0].size)
      expect(progress).toContain("download")
      expect(progress.at(-1)).toBe("loading")
      expect(setup.downloads.filter((url) => url.includes("huggingface.co"))).toHaveLength(1)
      const launches = children.length
      expect(await runtime.ensureServing(model, fit, setup.hardware)).toBe(endpoint)
      expect(children).toHaveLength(launches)
      if (failure === "startup") expect(children[0]?.exitCode).not.toBeNull()
    } finally {
      await runtime.stop()
    }
  })

  it("does not start Vulkan with PQ2 when the required PTQ1 download fails", async () => {
    const setup = await cudaRuntimeSetup("13.3", "prism")
    const originalFetch = setup.options.fetch
    if (!originalFetch) throw new Error("missing fake fetch")
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      listDevices: async (path) => (path.includes("-cuda-") ? "(none)" : "Vulkan0: NVIDIA"),
      fetch: (async (input, init) =>
        String(input).includes("huggingface.co")
          ? new Response("unavailable", { status: 503 })
          : await originalFetch(input, init)) as typeof fetch,
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow("HTTP 503")
    expect(setup.commands).toEqual([])
    expect(runtime.serving).toBeUndefined()
    expect((await stat(localGgufPath(setup.model, setup.directory))).size).toBe(setup.model.ggufFiles[0].size)
    await runtime.stop()
  })

  it.each([
    "12.8",
    "13.3",
  ] as const)("upgrades from Vulkan to CUDA %s without touching cached models, then reuses both verified archives", async (cudaVersion) => {
    const setup = await cudaRuntimeSetup(cudaVersion)
    const old = await installFakeBinary(setup.directory, "b10964")
    const runtime = new LlamaCppRuntime(setup.options)
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.downloads).toEqual(["https://runtime.test/cuda", "https://runtime.test/cudart"])
    expect(setup.commands[0]).toBe(join(setup.cudaDir, "llama-server"))
    expect(await readFile(join(setup.cudaDir, `libcublasLt.so.${cudaVersion.split(".")[0]}`), "utf8")).toBe("library")
    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(localGgufPath(setup.model, setup.directory))).resolves.toBeDefined()
    await runtime.stop()

    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it.each([
    "missing library",
    "missing manifest",
    "changed companion digest",
  ])("repairs a CUDA cache with %s", async (damage) => {
    const setup = await cudaRuntimeSetup()
    const runtime = new LlamaCppRuntime(setup.options)
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    await runtime.stop()
    if (damage === "missing library") await rm(join(setup.cudaDir, "libcublasLt.so.13"))
    if (damage === "missing manifest") await rm(join(setup.cudaDir, ".otis-runtime.json"))
    if (damage === "changed companion digest") {
      const path = join(setup.cudaDir, ".otis-runtime.json")
      const manifest = JSON.parse(await readFile(path, "utf8"))
      // The server archive still matches; the companion must match too.
      manifest.artifactSha256 = setup.options.runtimeAsset?.(setup.hardware, "upstream").sha256
      await writeFile(path, JSON.stringify(manifest))
    }
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.downloads).toHaveLength(4)
    await runtime.stop()
  })

  it.each([
    "checksum",
    "missing library",
    "cancel",
  ])("leaves the existing Vulkan runtime intact on companion %s failure", async (failure) => {
    const setup = await cudaRuntimeSetup()
    const old = await installFakeBinary(setup.directory, "b10964")
    const abort = new AbortController()
    const fetchRuntime = setup.options.fetch as typeof fetch
    setup.options.fetch = (async (input, init) => {
      if (String(input).endsWith("/cudart")) {
        if (failure === "checksum") return new Response("broken")
        if (failure === "cancel") abort.abort()
      }
      return await fetchRuntime(input, init)
    }) as typeof fetch
    if (failure === "missing library") {
      const extract = setup.options.extractArchive as NonNullable<LlamaCppRuntimeOptions["extractArchive"]>
      setup.options.extractArchive = async (archive, destination) => {
        await extract(archive, destination)
        if ((await readFile(archive, "utf8")) === "cudart") await rm(join(destination, "bundle", "libcublasLt.so.13"))
      }
    }
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(
      runtime.ensureServing(setup.model, setup.fit, setup.hardware, { signal: abort.signal }),
    ).rejects.toThrow()
    expect(await readFile(old, "utf8")).toBe("server")
    await expect(stat(setup.cudaDir)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(join(setup.directory, "bin"))).toEqual(["b10964"])
    expect(setup.commands).toEqual([])
    await runtime.stop()
  })

  it.each([
    "no CUDA device",
    "loader error",
  ])("falls back to Vulkan for %s and reuses both bundles on the next load", async (failure) => {
    const setup = await cudaRuntimeSetup()
    setup.options.listDevices = async (path) => {
      if (!path.includes("-cuda-")) return "Available devices:\n  Vulkan0: NVIDIA RTX"
      if (failure === "loader error") throw new Error("libcuda.so.1: cannot open shared object file")
      return "Available devices:\n"
    }
    const runtime = new LlamaCppRuntime(setup.options)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
      await runtime.stop()
    }
    expect(setup.downloads).toEqual([
      "https://runtime.test/cuda",
      "https://runtime.test/cudart",
      "https://runtime.test/vulkan",
    ])
    expect(setup.commands).toEqual(Array(2).fill(join(setup.directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server")))
  })

  it("does not fall back or start a server when cancelled during the CUDA device probe", async () => {
    const setup = await cudaRuntimeSetup()
    const abort = new AbortController()
    setup.options.listDevices = async () => {
      abort.abort()
      throw abort.signal.reason
    }
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(
      runtime.ensureServing(setup.model, setup.fit, setup.hardware, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(setup.downloads).toHaveLength(2)
    expect(setup.commands).toEqual([])
    await runtime.stop()
  })

  it("retains the previous release when CUDA is unavailable and the Vulkan download fails", async () => {
    const setup = await cudaRuntimeSetup()
    const old = await installFakeBinary(setup.directory, "b10964")
    setup.options.listDevices = async () => "Available devices:\n  (none)\n"
    const fetchRuntime = setup.options.fetch as typeof fetch
    setup.options.fetch = (async (input, init) =>
      String(input).endsWith("/vulkan")
        ? new Response("missing", { status: 404 })
        : await fetchRuntime(input, init)) as typeof fetch
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow("HTTP 404")
    expect(await readFile(old, "utf8")).toBe("server")
    expect(setup.commands).toEqual([])
    await runtime.stop()
  })
})

async function cudaRuntimeSetup(cudaVersion: "12.8" | "13.3" = "13.3", runtime: LlamaRuntimeKind = "upstream") {
  const cudaHardware: HardwareProbe = {
    ...hardware,
    platform: "linux",
    arch: "x64",
    backend: "cuda",
    cudaVersion,
    unifiedMemory: false,
  }
  const spec = runtime === "prism" ? findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf") : catalogModel()
  if (!spec) throw new Error("missing local model")
  const fit = fitLocalModel(spec, cudaHardware)
  const model = fit.model
  const directory = await tempDir()
  await cacheWeights(model, directory)
  const downloads: string[] = []
  const commands: string[] = []
  const archive = (name: string) => ({
    name,
    url: `https://runtime.test/${name}`,
    size: name.length,
    sha256: createHash("sha256").update(name).digest("hex"),
  })
  const options: LlamaCppRuntimeOptions = {
    env: {},
    dataDirectory: directory,
    runtimeAsset: (target) =>
      target.backend === "cuda" ? { ...archive("cuda"), companion: archive("cudart") } : archive("vulkan"),
    allocatePort: async () => 18775,
    listDevices: async (path) =>
      `Available devices:\n  ${path.includes("-cuda-") ? "CUDA0" : "Vulkan0"}: NVIDIA RTX (24576 MiB, 23000 MiB free)\n`,
    spawn: ((command) => {
      commands.push(String(command))
      return fakeChild()
    }) as LlamaCppRuntimeOptions["spawn"],
    fetch: (async (input) => {
      const url = String(input)
      if (url.includes("/health")) return new Response("ok")
      if (url.includes("/props")) return runtimeProperties(fit.contextLength)
      downloads.push(url)
      if (url.startsWith("https://runtime.test/")) return new Response(url.split("/").at(-1))
      throw new Error(`Unexpected download: ${url}`)
    }) as typeof fetch,
    extractArchive: async (archivePath, destination) => {
      const kind = await readFile(archivePath, "utf8")
      const bundle = join(destination, "bundle")
      await mkdir(bundle)
      const files =
        kind === "cudart"
          ? ["libcudart", "libcublas", "libcublasLt"].map((name) => `${name}.so.${cudaVersion.split(".")[0]}`)
          : ["llama-server", "libllama.so", "libggml.so", `libggml-${kind}.so`]
      for (const file of files) await writeFile(join(bundle, file), "library")
    },
  }
  return {
    model,
    fit,
    hardware: cudaHardware,
    directory,
    cudaDir: join(directory, "bin", `${llamaRuntimeReleaseTag(runtime)}-cuda-${cudaVersion}`),
    options,
    downloads,
    commands,
  }
}

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

function runtimeDownloadOptions(
  directory: string,
  fetchRuntime: typeof fetch,
  overrides: Partial<LlamaCppRuntimeOptions> = {},
): LlamaCppRuntimeOptions {
  return {
    env: {},
    dataDirectory: directory,
    runtimeAsset: fakeRuntimeAsset,
    allocatePort: async () => 18773,
    spawn: (() => fakeChild()) as unknown as LlamaCppRuntimeOptions["spawn"],
    fetch: fetchRuntime,
    extractArchive: async (_archive, destination) => {
      const bundle = join(destination, "bin")
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, "llama-server"), "server")
      await writeFile(join(bundle, "libllama.dylib"), "llama library")
      await writeFile(join(bundle, "libggml.dylib"), "ggml library")
    },
    ...overrides,
  }
}
