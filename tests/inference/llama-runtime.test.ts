import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { localGgufPath } from "../../src/inference/gguf-cache.js"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import { LLAMA_CPP_RELEASE_TAG, pinnedLlamaCppAsset } from "../../src/inference/llama-binary.js"
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
