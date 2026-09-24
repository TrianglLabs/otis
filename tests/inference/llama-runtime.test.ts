import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HardwareProbe, inferenceMemoryBudget } from "../../src/inference/hardware.js"
import {
  type LlamaRuntimeKind,
  llamaRuntimeReleaseTag,
  pinnedLlamaCppAsset,
} from "../../src/inference/llama-binary.js"
import { formatLocalLoadStatus, LlamaCppRuntime } from "../../src/inference/llama-runtime.js"
import { findLocalModel, type LocalModelSpec } from "../../src/inference/local-catalog.js"
import { LlamaCppClient } from "../../src/inference/local-client.js"
import { fitLocalModel } from "../../src/inference/local-fit.js"

type LlamaCppRuntimeOptions = NonNullable<ConstructorParameters<typeof LlamaCppRuntime>[0]>

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
/** The pinned release tags, read from the asset table's download URLs. */
const releaseTagOf = (runtime: LlamaRuntimeKind) =>
  pinnedLlamaCppAsset(hardware, runtime).url.split("/").at(-2) ?? ""
const LLAMA_CPP_RELEASE_TAG = releaseTagOf("upstream")
const PRISM_LLAMA_CPP_RELEASE_TAG = releaseTagOf("prism")
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
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("llama.cpp runtime", () => {
  it("labels the runtime download, verification, and loading phases", () => {
    expect(formatLocalLoadStatus({ phase: "runtime-download" })).toBe("Downloading llama.cpp")
    expect(formatLocalLoadStatus({ phase: "download", percent: 42 })).toBe("Downloading 42%")
    expect(formatLocalLoadStatus({ phase: "verifying", percent: 7 })).toBe("Verifying 7%")
    expect(formatLocalLoadStatus({ phase: "loading" })).toBe("Loading")
  })

  it("reports verification of a legacy cached GGUF before loading", async () => {
    const model = catalogModel()
    const fit = fitLocalModel(model, hardware)
    const directory = await tempDir()
    const body = new Uint8Array([9, 8, 7, 6])
    const tiny = tinyModel(model, body)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(localGgufPath(tiny, directory), body)
    await installFakeBinary(directory, LLAMA_CPP_RELEASE_TAG)
    const progress: Parameters<typeof formatLocalLoadStatus>[0][] = []
    const runtime = new LlamaCppRuntime({
      env: {},
      dataDirectory: directory,
      allocatePort: async () => 18766,
      spawn: (() => fakeChild()) as unknown as LlamaCppRuntimeOptions["spawn"],
      fetch: huggingfaceFetch(body, fit.contextLength),
    })
    await runtime.ensureServing(tiny, { ...fit, model: tiny }, hardware, {
      onProgress: (event) => progress.push(event),
    })
    expect(progress).toEqual([
      { phase: "verifying", percent: 100 },
      { phase: "download", percent: 100 },
      { phase: "loading" },
    ])
    await runtime.stop()
  })

  it("resumes an interrupted runtime download by byte range", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const ranges: Array<string | null> = []
    const fetchRuntime = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url !== pinnedArchiveURL) return new Response("missing", { status: 404 })
      const range = new Headers(init?.headers).get("range")
      ranges.push(range)
      if (range === null) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(archiveBody.subarray(0, 3))
            },
            pull(controller) {
              controller.error(new Error("connection reset"))
            },
          }),
          { headers: { "content-length": String(archiveBody.byteLength) } },
        )
      }
      expect(range).toBe("bytes=3-")
      return new Response(archiveBody.subarray(3), {
        status: 206,
        headers: {
          "content-length": String(archiveBody.byteLength - 3),
          "content-range": `bytes 3-${archiveBody.byteLength - 1}/${archiveBody.byteLength}`,
        },
      })
    })
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(
        directory,
        (async (input, init) => {
          const url = String(input)
          if (url.includes("/health")) return new Response("ok")
          if (url.includes("/props")) return runtimeProperties(65_536)
          if (url.endsWith("/v1/chat/completions")) return generationResponse()
          return await fetchRuntime(input, init)
        }) as typeof fetch,
        { sleep: async () => {} },
      ),
    )
    await runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)
    expect(ranges).toEqual([null, "bytes=3-"])
    expect(
      await readFile(join(directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server"), "utf8"),
    ).toBe("server")
    // Nothing is left to resume once the bundle is installed.
    expect(await readdir(join(directory, "downloads"))).toEqual([])
    await runtime.stop()
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
    expect(await readFile(join(dirname(binary as string), "libllama.dylib"), "utf8")).toBe(
      "llama library",
    )
    await expect(
      readFile(join(dirname(binary as string), ".otis-runtime.json"), "utf8"),
    ).resolves.toContain(`"artifactSha256":"${fakeRuntimeAsset(hardware, "upstream").sha256}"`)
    expect(await readFile(join(dirname(binary as string), "ggml-metal.metal"), "utf8")).toBe(
      "metal backend",
    )
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
      ...(change === "checksum"
        ? { ggufFiles: [{ ...first.ggufFiles[0], sha256: "a".repeat(64) }] }
        : {}),
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
      expect(spawnedPaths).toEqual([
        localGgufPath(first, directory),
        localGgufPath(second, directory),
      ])
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
              return new Response("gateway timeout", {
                status: 504,
                headers: { "retry-after": "2" },
              })
            }
            if (downloads === 2) throw new TypeError("connection reset")
            return new Response(archiveBody)
          }
          if (url.includes("/health")) return new Response("ok")
          if (url.includes("/props")) return runtimeProperties(65_536)
          if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
    const runtime = new LlamaCppRuntime(
      runtimeDownloadOptions(directory, fetchRuntime, { sleep: retry }),
    )

    await expect(
      runtime.ensureServing(model, fitLocalModel(model, hardware), hardware),
    ).rejects.toThrow("Could not download llama.cpp (HTTP 404).")
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
          if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
    {
      status: 200,
      contentLength: "100",
      attempts: 3,
      message: "Expected 7 bytes but received 100",
    },
    { status: 200, attempts: 3, message: "exceeded the pinned artifact size" },
  ])("closes rejected runtime responses before retrying ($message)", async ({
    status,
    contentLength,
    attempts,
    message,
  }) => {
    const model = catalogModel()
    const directory = await tempDir()
    const responses: {
      response: Response
      signal: AbortSignal
      cancel: ReturnType<typeof vi.fn>
    }[] = []
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
      await expect(
        runtime.ensureServing(model, fitLocalModel(model, hardware), hardware),
      ).rejects.toThrow(message)
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

    await expect(
      runtime.ensureServing(model, fitLocalModel(model, hardware), hardware),
    ).rejects.toThrow("Could not download llama.cpp: The request timed out.")
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
      const pending = runtime.ensureServing(model, fitLocalModel(model, hardware), hardware, {
        signal: abort.signal,
      })
      const result =
        action === "cancel"
          ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
          : expect(pending).rejects.toThrow("Could not download llama.cpp: The request timed out.")
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
    ["unified memory", hardware],
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
    ],
  ] as const)("downloads the GGUF and passes the per-device margin for %s", async (_label, hardware) => {
    const targetMiB = inferenceMemoryBudget(hardware).deviceHeadroomBytes / 1024 ** 2
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
    expect(
      (await runtime.ensureServing(model, { ...fit, contextLength: fittedContext }, hardware))
        .contextLength,
    ).toBe(fittedContext)
    expect(spawned).toHaveLength(1)
    expect(progress).toEqual(
      expect.arrayContaining([{ phase: "download", percent: 100 }, { phase: "loading" }]),
    )
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
        DYLD_LIBRARY_PATH: "/opt/metal/lib",
        MTL_DEBUG_LAYER: "0",
        HF_TOKEN: "hf_secret",
        HUGGING_FACE_HUB_TOKEN: "hf_secret",
        FIREWORKS_API_KEY: "fw_secret",
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
        return new Response("ok")
      }) as typeof fetch,
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(childEnv).toEqual({
      PATH: "/usr/bin",
      DYLD_LIBRARY_PATH: "/opt/metal/lib",
      MTL_DEBUG_LAYER: "0",
      LLAMA_CACHE: join(directory, "models"),
    })
    await runtime.stop()
  })

  it("reaps a recorded llama-server left by a crashed Otis before starting another", async () => {
    const { runtime, model, fit, children, directory, signals, alive } = await orphanSetup({
      ownerPid: 999_999,
      command: `${process.execPath} --model weights.gguf --port 18701`,
    })

    await runtime.ensureServing(model, fit, hardware)

    expect(signals).toEqual([[4242, "SIGTERM"]])
    expect(alive.has(4242)).toBe(false)
    const ownRecord = join(directory, "servers", `${process.pid}.json`)
    expect(JSON.parse(await readFile(ownRecord, "utf8"))).toMatchObject({
      pid: children[0]?.pid,
      ownerPid: process.pid,
      port: 18765,
      binaryPath: process.execPath,
    })
    await expect(stat(join(directory, "servers", "999999.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await runtime.stop()
    await expect(stat(ownRecord)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reaps dead owners' servers, leaves live owners' alone, and drops the legacy record", async () => {
    const { runtime, model, fit, signals, alive, directory } = await orphanSetup({
      ownerPid: 999_999,
      alivePids: [4242, 4343, 4444],
      command: `${process.execPath} --model weights.gguf --port 18701`,
      commands: { 4343: `${process.execPath} --model weights.gguf --port 18702` },
    })
    const record = (pid: number, ownerPid: number) =>
      JSON.stringify({ pid, ownerPid, port: 18702, binaryPath: process.execPath })
    await writeFile(join(directory, "servers", "4444.json"), record(4343, 4444))
    await writeFile(join(directory, "server.json"), record(4242, 999_998))

    await runtime.ensureServing(model, fit, hardware)

    expect(signals).toEqual([[4242, "SIGTERM"]])
    expect(alive.has(4343)).toBe(true)
    expect(new Set(await readdir(join(directory, "servers")))).toEqual(
      new Set(["4444.json", `${process.pid}.json`]),
    )
    await expect(stat(join(directory, "server.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await runtime.stop()
  })

  it.each([
    ["dead", { alivePids: [], command: `${process.execPath} --model weights.gguf` }],
    ["unrelated", { alivePids: [4242], command: "/usr/bin/python3 train.py" }],
  ])("ignores and removes a stale server record whose pid is %s", async (_label, setup) => {
    const { runtime, model, fit, signals, recordBeforeSpawn } = await orphanSetup({
      ownerPid: 999_999,
      ...setup,
    })
    const serving = await runtime.ensureServing(model, fit, hardware)
    expect(serving.model).toBe(model.id)
    expect(signals).toEqual([])
    expect(recordBeforeSpawn()).toBe("removed")
    await runtime.stop()
  })

  it("leaves another running Otis's server alone", async () => {
    const { runtime, model, fit, signals } = await orphanSetup({
      ownerPid: 4343,
      alivePids: [4242, 4343],
      command: `${process.execPath} --model weights.gguf`,
    })
    await runtime.ensureServing(model, fit, hardware)
    expect(signals).toEqual([])
    await runtime.stop()
  })

  it("reports a server that died mid-session on the next request until it is reselected", async () => {
    const generation = vi.fn(async () => generationResponse())
    const { runtime, model, fit, children } = await generationRuntimeSetup(
      generation as unknown as typeof fetch,
    )
    const serving = await runtime.ensureServing(model, fit, hardware)
    const requests = vi.fn(async () => generationResponse())
    const client = new LlamaCppClient({
      model: model.id,
      inferenceURL: serving.inferenceURL,
      assertServing: () => runtime.assertServing(),
      fetch: requests as unknown as typeof fetch,
    })
    const request = { messages: [{ role: "user" as const, content: "hi" }] }
    await client.streamChat(request).next()
    expect(requests).toHaveBeenCalledOnce()

    const child = children[0]
    if (!child) throw new Error("Missing server process")
    child.stderr.emit("data", `${"x".repeat(3_000)}\nggml_metal: failed to allocate buffer\n`)
    child.signalCode = "SIGKILL"
    child.emit("exit", null, "SIGKILL")
    const failure = expect(client.streamChat(request).next()).rejects
    await failure.toThrow("The local model server exited unexpectedly (signal SIGKILL).")
    await failure.toThrow("ggml_metal: failed to allocate buffer")
    await failure.toThrow("Reselect the model to restart it.")
    await expect(client.countTokens(request)).rejects.toThrow("Reselect the model")
    expect(requests).toHaveBeenCalledOnce()

    const restarted = await runtime.ensureServing(model, fit, hardware)
    expect(children).toHaveLength(2)
    expect(restarted.inferenceURL).toBe(serving.inferenceURL)
    expect(() => runtime.assertServing()).not.toThrow()
    await client.streamChat(request).next()
    expect(requests).toHaveBeenCalledTimes(2)
    await runtime.stop()
    expect(() => runtime.assertServing()).not.toThrow()
  })

  it("marks a model ready only after generation finishes and probes each process once", async () => {
    let finish: ((response: Response) => void) | undefined
    const request = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const { runtime, model, fit, children } = await generationRuntimeSetup(
      request as unknown as typeof fetch,
    )
    const pending = runtime.ensureServing(model, fit, hardware)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const concurrent = runtime.ensureServing(model, fit, hardware)
    expect(runtime.serving).toBeUndefined()
    finish?.(generationResponse())
    const serving = await pending
    expect(await concurrent).toBe(serving)
    expect(await runtime.ensureServing(model, fit, hardware)).toBe(serving)
    expect(request).toHaveBeenCalledOnce()
    expect(children).toHaveLength(1)
    expect(serving.contextLength).toBe(65_536)
    // Only the lifetime listener that notices a mid-session exit remains after startup.
    expect(children[0]?.listenerCount("exit")).toBe(1)
    await runtime.stop()
  })

  it("stops a process whose generation fails and allows a fresh start", async () => {
    const request = vi
      .fn(async () => generationResponse())
      .mockResolvedValueOnce(
        Response.json({ error: { message: "compute allocation failed" } }, { status: 500 }),
      )
    const { runtime, model, fit, children } = await generationRuntimeSetup(
      request as unknown as typeof fetch,
    )
    await expect(runtime.ensureServing(model, fit, hardware)).rejects.toThrow(
      "generation check failed",
    )
    expect(runtime.serving).toBeUndefined()
    expect(children[0]?.exitCode).toBe(0)
    expect(request).toHaveBeenCalledOnce()
    await runtime.ensureServing(model, fit, hardware)
    expect(runtime.serving?.model).toBe(model.id)
    expect(children).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
    await runtime.stop()
  })

  it.each(["cancel", "stop"])("aborts a pending generation check on %s", async (action) => {
    let requestSignal: AbortSignal | undefined
    const request = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      return await pendingGeneration(requestSignal)
    }) as typeof fetch
    const { runtime, model, fit, children } = await generationRuntimeSetup(request)
    const abort = new AbortController()
    const rejected = expect(
      runtime.ensureServing(model, fit, hardware, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    if (action === "cancel") abort.abort()
    else await runtime.stop()
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(runtime.serving).toBeUndefined()
    expect(children[0]?.exitCode).toBe(0)
  })

  it("aborts generation immediately when the child exits, preserving its diagnostic", async () => {
    let requestSignal: AbortSignal | undefined
    const request = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      return await pendingGeneration(requestSignal)
    }) as typeof fetch
    const { runtime, model, fit, children } = await generationRuntimeSetup(request)
    const rejected = expect(runtime.ensureServing(model, fit, hardware)).rejects.toThrow(
      "failed to allocate decode buffer",
    )
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const child = children[0]
    if (!child) throw new Error("Missing server process")
    child.stderr.emit("data", "failed to allocate decode buffer")
    child.exitCode = 1
    child.emit("exit", 1)
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(runtime.serving).toBeUndefined()
  })

  it.each(["headers", "body"])("stops the process when generation %s time out", async (stage) => {
    let requestSignal: AbortSignal | undefined
    const request = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      if (stage === "headers") return await pendingGeneration(requestSignal)
      const signal = requestSignal
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            })
          },
        }),
      )
    }) as typeof fetch
    const { runtime, model, fit, children } = await generationRuntimeSetup(request, {
      generationCheckTimeoutMs: 20,
    })
    await expect(runtime.ensureServing(model, fit, hardware)).rejects.toThrow(
      "generation check timed out",
    )
    expect(requestSignal?.aborted).toBe(true)
    expect(runtime.serving).toBeUndefined()
    expect(children[0]?.exitCode).toBe(0)
  })

  it("sends only a bounded, minimally reasoned startup prompt to the new server", async () => {
    const request = vi.fn(async () => generationResponse())
    const { runtime, model, fit } = await generationRuntimeSetup(request as unknown as typeof fetch)
    await runtime.ensureServing(model, fit, hardware)
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:18765/v1/chat/completions")
    expect(init).toMatchObject({ method: "POST", redirect: "error" })
    expect(JSON.parse(String(init.body))).toEqual({
      model: model.id,
      messages: [{ role: "user", content: "Say hello." }],
      stream: true,
      max_tokens: 8,
      reasoning_effort: "low",
    })
    expect(request).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it("turns thinking off for the startup probe when the model's template allows it", async () => {
    const model = findLocalModel("Qwen/Qwen3.8-27B")
    if (!model) throw new Error("missing catalog entry")
    const directory = await tempDir()
    await cacheWeights(model, directory)
    const bodies: Record<string, unknown>[] = []
    const runtime = new LlamaCppRuntime({
      env: { OTIS_LLAMA_SERVER: process.execPath },
      dataDirectory: directory,
      allocatePort: async () => 18766,
      spawn: (() => fakeChild()) as unknown as LlamaCppRuntimeOptions["spawn"],
      fetch: (async (input, init) => {
        if (String(input).endsWith("/props")) return runtimeProperties(65_536)
        if (String(input).endsWith("/v1/chat/completions")) {
          bodies.push(JSON.parse(String(init?.body)))
          return generationResponse()
        }
        return new Response("ok")
      }) as typeof fetch,
    })
    await runtime.ensureServing(model, fitLocalModel(model, hardware), hardware)
    expect(bodies).toEqual([
      expect.objectContaining({
        max_tokens: 8,
        chat_template_kwargs: { enable_thinking: false },
      }),
    ])
    expect(bodies[0]).not.toHaveProperty("reasoning_effort")
    await runtime.stop()
  })

  it.each([
    ["GPU", hardware, false, 120_000],
    ["CPU offload", hardware, true, 600_000],
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
      false,
      600_000,
    ],
  ] as const)("gives the generation probe on %s its deadline", async (_label, hardware, offload, deadline) => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const request = vi.fn(async () => generationResponse())
    const { runtime, model } = await generationRuntimeSetup(request as unknown as typeof fetch)
    const fit = { ...fitLocalModel(model, hardware), requiresCpuOffload: offload }
    await runtime.ensureServing(model, fit, hardware)
    expect(timeout).toHaveBeenCalledWith(deadline)
    expect(timeout).not.toHaveBeenCalledWith(deadline === 120_000 ? 600_000 : 120_000)
    await runtime.stop()
  })

  it.each([
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ])("accepts %s when a reasoning model reaches the probe output limit", async (field) => {
    const request = vi.fn(async () =>
      generationResponse({ [field]: "The user asked for a greeting." }, "length"),
    )
    const { runtime, model, fit } = await generationRuntimeSetup(request as unknown as typeof fetch)
    await expect(runtime.ensureServing(model, fit, hardware)).resolves.toMatchObject({
      model: model.id,
    })
    await runtime.stop()
  })

  it.each([
    ["empty output", () => generationResponse({ content: " \n" }), "produced no text or reasoning"],
    ["broken stream", () => generationResponse({ content: "Hello" }, null), "did not finish"],
    [
      "unexpected finish",
      () => generationResponse({ content: "Hello" }, "content_filter"),
      "did not finish",
    ],
    ["invalid stream", () => new Response("data: {invalid}\n\n"), "Invalid inference stream"],
    ["plain health response", () => new Response("ok"), "produced no text or reasoning"],
    ["missing body", () => new Response(null), "no response body"],
    [
      "stream error",
      () => new Response('data: {"error":{"message":"decode failed"}}\n\n'),
      "decode failed",
    ],
    [
      "unexpected tool call",
      () =>
        generationResponse(
          {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: "{}" } }],
          },
          "tool_calls",
        ),
      "unexpected tool call",
    ],
  ] as const)("rejects a generation check with %s without retrying", async (_label, response, message) => {
    const request = vi.fn(async () => response())
    const { runtime, model, fit, children } = await generationRuntimeSetup(
      request as unknown as typeof fetch,
    )
    await expect(runtime.ensureServing(model, fit, hardware)).rejects.toThrow(message)
    expect(request).toHaveBeenCalledOnce()
    expect(runtime.serving).toBeUndefined()
    expect(children[0]?.exitCode).toBe(0)
  })

  it("does not let a superseded generation check stop the replacement model", async () => {
    let requestSignal: AbortSignal | undefined
    const request = (async (_input, init) => {
      if (requestSignal) return generationResponse()
      requestSignal = init?.signal ?? undefined
      return await pendingGeneration(requestSignal)
    }) as typeof fetch
    const { runtime, model, fit, children, directory } = await generationRuntimeSetup(request)
    const other = findLocalModel("Qwen/Qwen3.8-27B")
    if (!other) throw new Error("Missing replacement model")
    await cacheWeights(other, directory)
    const rejected = expect(runtime.ensureServing(model, fit, hardware)).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const serving = await runtime.ensureServing(other, fitLocalModel(other, hardware), hardware)
    await rejected
    expect(runtime.serving).toBe(serving)
    expect(serving.model).toBe(other.id)
    expect(children[0]?.exitCode).toBe(0)
    expect(children[1]?.exitCode).toBeNull()
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
    const tight: HardwareProbe = {
      ...hardware,
      totalMemoryBytes: 8 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
    }
    const runtime = new LlamaCppRuntime({ env: { OTIS_LLAMA_SERVER: process.execPath } })
    await expect(runtime.ensureServing(model, fitLocalModel(model, tight), tight)).rejects.toThrow(
      "needs",
    )
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

    await expect(
      runtime.ensureServing(model, fitLocalModel(model, unsupported), unsupported),
    ).rejects.toThrow("Local inference is not supported on win32/x64.")
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
        if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
        return new Response("ok")
      }) as typeof fetch,
    })

    const first = runtime.ensureServing(firstModel, fitLocalModel(firstModel, hardware), hardware)
    await portStarted
    const second = runtime.ensureServing(
      secondModel,
      fitLocalModel(secondModel, hardware),
      hardware,
    )
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

    const error = await runtime.ensureServing(model, fitLocalModel(model, hardware), hardware).then(
      () => undefined,
      (error: Error & { output: string }) => error,
    )
    expect(error?.output).toMatch(/FIRST-TAIL[\s\S]*FINAL/)
    // The message keeps the last line only; the log stays on the error for diagnostics.
    expect(error?.message).toMatch(
      /^The local model server stopped before it was ready \(code 1\): …z+FINAL$/,
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

    await expect(
      runtime.ensureServing(model, fitLocalModel(model, hardware), hardware),
    ).rejects.toThrow("SHA-256 verification failed")
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
    const listDevices = setup.options.listDevices as NonNullable<
      LlamaCppRuntimeOptions["listDevices"]
    >
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
      for (const name of [
        "LD_PRELOAD",
        "LD_AUDIT",
        "GGML_BACKEND_PATH",
        "FIREWORKS_API_KEY",
        "LLAMA_ARG_DEVICE",
      ]) {
        expect(env[name]).toBeUndefined()
      }
    }
    expect(parent).toEqual(before)
    await runtime.stop()
  })

  it.each([
    undefined,
    "",
    ":;",
  ])("uses only the bundle when the inherited library path is %s", async (libraryPath) => {
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

  it("keeps the verified CUDA archive when its companion download fails, then reuses it", async () => {
    const setup = await cudaRuntimeSetup()
    let companionFailures = 1
    const fetchRuntime = setup.options.fetch as typeof fetch
    setup.options.fetch = (async (input, init) => {
      if (String(input).endsWith("/cudart") && companionFailures > 0) {
        companionFailures -= 1
        setup.downloads.push(String(input))
        return new Response("missing", { status: 404 })
      }
      return await fetchRuntime(input, init)
    }) as typeof fetch
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "HTTP 404",
    )
    const downloads = join(setup.directory, "downloads")
    expect(await readdir(downloads)).toEqual(["cuda"])
    expect(setup.commands).toEqual([])

    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.downloads).toEqual([
      "https://runtime.test/cuda",
      "https://runtime.test/cudart",
      "https://runtime.test/cudart",
    ])
    expect(await readdir(downloads)).toEqual([])
    expect(setup.commands).toEqual([join(setup.cudaDir, "llama-server")])
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
    const { OTIS_LLAMA_SERVER: _server, ...loaderSettings } = env
    expect(childEnv).toMatchObject(loaderSettings)
    expect(childEnv).not.toHaveProperty("OTIS_LLAMA_SERVER")
    expect(listDevices).not.toHaveBeenCalled()
    expect(setup.downloads).toEqual([])
    await runtime.stop()
  })

  it("forwards only loader, GPU, locale, and display settings to the server and its probe", async () => {
    const setup = await cudaRuntimeSetup()
    const parent = Object.freeze({
      PATH: "/usr/bin",
      HOME: "/home/otis",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LD_LIBRARY_PATH: "/opt/nvidia/lib",
      CUDA_VISIBLE_DEVICES: "0",
      NVIDIA_VISIBLE_DEVICES: "all",
      GGML_VK_VISIBLE_DEVICES: "0",
      VK_ICD_FILENAMES: "/etc/vulkan/icd.d/nvidia_icd.json",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_DATA_HOME: "/home/otis/.local/share",
      HF_TOKEN: "hf_secret",
      HUGGING_FACE_HUB_TOKEN: "hf_secret",
      FIREWORKS_API_KEY: "fw_secret",
      OMLX_API_KEY: "omlx_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      DYLD_LIBRARY_PATH: "/opt/mac/lib",
    })
    const environments: NodeJS.ProcessEnv[] = []
    const listDevices = setup.options.listDevices as NonNullable<
      LlamaCppRuntimeOptions["listDevices"]
    >
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      env: parent,
      listDevices: async (path, env, signal) => {
        environments.push(env)
        return await listDevices(path, env, signal)
      },
      spawn: ((_command, _args, options) => {
        environments.push(options?.env ?? {})
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(environments).toHaveLength(2)
    for (const env of environments) {
      expect(env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/otis",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        LD_LIBRARY_PATH: `${setup.cudaDir}:/opt/nvidia/lib`,
        CUDA_VISIBLE_DEVICES: "0",
        NVIDIA_VISIBLE_DEVICES: "all",
        GGML_VK_VISIBLE_DEVICES: "0",
        VK_ICD_FILENAMES: "/etc/vulkan/icd.d/nvidia_icd.json",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_DATA_HOME: "/home/otis/.local/share",
        LLAMA_CACHE: join(setup.directory, "models"),
      })
    }
    await runtime.stop()
  })

  it("retries once on a fresh port when llama-server cannot bind, without a backend retry", async () => {
    const setup = await cudaRuntimeSetup()
    const ports = [18775, 18776, 18777]
    const spawnedPorts: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      allocatePort: async () => {
        const port = ports.shift()
        if (!port) throw new Error("port allocation exhausted")
        return port
      },
      spawn: ((_command: string, args: readonly string[]) => {
        const child = fakeChild()
        const port = String(args[args.indexOf("--port") + 1])
        spawnedPorts.push(port)
        if (spawnedPorts.length === 1)
          queueMicrotask(() => {
            child.stderr.emit(
              "data",
              `couldn't bind HTTP server socket, hostname: 127.0.0.1, port: ${port}`,
            )
            child.exitCode = 1
            child.emit("exit", 1)
          })
        return child
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    const serving = await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(spawnedPorts).toEqual(["18775", "18776"])
    expect(serving.inferenceURL).toBe("http://127.0.0.1:18776/v1/chat/completions")
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("reports a bind failure that repeats on the second port", async () => {
    const setup = await cudaRuntimeSetup()
    const spawnRuntime = vi.fn(() => {
      const child = fakeChild()
      queueMicrotask(() => {
        child.stderr.emit("data", "failed to bind to address 127.0.0.1")
        child.exitCode = 1
        child.emit("exit", 1)
      })
      return child
    })
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: spawnRuntime as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "failed to bind to address 127.0.0.1",
    )
    expect(spawnRuntime).toHaveBeenCalledTimes(2)
    expect(setup.downloads).toHaveLength(2)
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
    const notices: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      spawn: ((command, args, options) => {
        const child = fakeChild()
        children.push(child)
        paths.push(String(command))
        const cuda = children.length === 1
        expect(args?.slice(-2)).toEqual(["--device", cuda ? "CUDA0" : "Vulkan0"])
        expect(options?.env?.LD_LIBRARY_PATH).toBe(
          `${dirname(String(command))}:/opt/cuda-other/lib:/usr/lib/wsl/lib`,
        )
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
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware, {
      onNotice: (message) => notices.push(message),
    })
    expect(notices).toEqual([`CUDA failed (${diagnostic}); running on Vulkan.`])
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
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      diagnostic.split("\n").at(-1),
    )
    expect(spawnRuntime).toHaveBeenCalledOnce()
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("falls back to the CPU bundle when Vulkan also fails during model loading", async () => {
    const setup = await cudaRuntimeSetup()
    const diagnostics = ["CUDA error: initialization error", "ggml_vulkan: device lost"]
    const notices: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      runtimeAsset: cpuAwareRuntimeAsset(setup),
      spawn: ((command: string) => {
        const child = fakeChild()
        setup.commands.push(command)
        const diagnostic = diagnostics.shift()
        if (diagnostic)
          queueMicrotask(() => {
            child.stderr.emit("data", diagnostic)
            child.exitCode = 1
            child.emit("exit", 1)
          })
        return child
      }) as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    const serving = await runtime.ensureServing(setup.model, setup.fit, setup.hardware, {
      onNotice: (message) => notices.push(message),
    })
    expect(serving.model).toBe(setup.model.id)
    expect(setup.commands).toEqual([
      join(setup.cudaDir, "llama-server"),
      join(setup.directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server"),
      join(setup.directory, "bin", `${LLAMA_CPP_RELEASE_TAG}-cpu`, "llama-server"),
    ])
    expect(notices).toEqual([
      "CUDA failed (CUDA error: initialization error); running on Vulkan.",
      "CUDA failed (CUDA error: initialization error) and Vulkan failed " +
        "(ggml_vulkan: device lost); running on CPU.",
    ])
    // The CPU bundle stays beside the GPU bundles; the pinned release owns all three.
    expect((await readdir(join(setup.directory, "bin"))).sort()).toEqual([
      LLAMA_CPP_RELEASE_TAG,
      `${LLAMA_CPP_RELEASE_TAG}-cpu`,
      `${LLAMA_CPP_RELEASE_TAG}-cuda-13.3`,
    ])
    // Reuse the live CPU process under the original hardware selection.
    expect(await runtime.ensureServing(setup.model, setup.fit, setup.hardware)).toBe(serving)
    expect(setup.commands).toHaveLength(3)
    await runtime.stop()
  })

  it("keeps an unrelated Vulkan load failure, carrying the CUDA cause, without a CPU retry", async () => {
    const setup = await cudaRuntimeSetup()
    const diagnostics = [
      "CUDA error: initialization error",
      "error loading model: invalid GGUF tensor",
    ]
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      runtimeAsset: cpuAwareRuntimeAsset(setup),
      spawn: ((command: string) => {
        const child = fakeChild()
        setup.commands.push(command)
        const diagnostic = diagnostics.shift()
        queueMicrotask(() => {
          child.stderr.emit("data", diagnostic ?? "unexpected launch")
          child.exitCode = 1
          child.emit("exit", 1)
        })
        return child
      }) as unknown as LlamaCppRuntimeOptions["spawn"],
    })
    const failure = expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects
    await failure.toThrow("error loading model: invalid GGUF tensor")
    await failure.toThrow("Earlier: CUDA failed (CUDA error: initialization error).")
    expect(setup.commands).toHaveLength(2)
    expect(setup.downloads).not.toContain("https://runtime.test/cpu")
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
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "spawn EACCES",
    )
    expect(spawnRuntime).toHaveBeenCalledOnce()
    expect(setup.downloads).toHaveLength(2)
    await runtime.stop()
  })

  it("does not treat an invalid context response as a CUDA backend failure", async () => {
    const setup = await cudaRuntimeSetup()
    const fetchRuntime = setup.options.fetch as typeof fetch
    setup.options.fetch = (async (input, init) =>
      String(input).includes("/props")
        ? runtimeProperties(0)
        : await fetchRuntime(input, init)) as typeof fetch
    const runtime = new LlamaCppRuntime(setup.options)
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "valid context size",
    )
    expect(setup.commands).toHaveLength(1)
    expect(setup.downloads).toHaveLength(2)
    expect(runtime.serving).toBeUndefined()
    await runtime.stop()
  })

  it.each([
    ["Available devices:\n  (none)", "no Vulkan device was reported"],
    ["Available devices:\n  CUDA0: NVIDIA RTX", "no Vulkan device was reported"],
    [new Error("libvulkan.so.1: cannot open shared object file"), "libvulkan.so.1: cannot open"],
  ])("runs on the CPU bundle, saying why, when neither CUDA nor Vulkan reports a device: %s", async (vulkanProbe, cause) => {
    const setup = await cudaRuntimeSetup()
    const old = await installFakeBinary(setup.directory, "b10964")
    const notices: string[] = []
    const runtime = new LlamaCppRuntime({
      ...setup.options,
      runtimeAsset: cpuAwareRuntimeAsset(setup),
      listDevices: async (path) => {
        if (path.includes("-cuda-")) return "Available devices:\n  (none)"
        if (vulkanProbe instanceof Error) throw vulkanProbe
        return vulkanProbe
      },
      spawn: ((_command, args) => {
        expect(args).not.toContain("--device")
        setup.commands.push(String(_command))
        return fakeChild()
      }) as LlamaCppRuntimeOptions["spawn"],
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware, {
      onNotice: (message) => notices.push(message),
    })
    expect(setup.commands).toEqual([
      join(setup.directory, "bin", `${LLAMA_CPP_RELEASE_TAG}-cpu`, "llama-server"),
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^CUDA failed \(no CUDA device was reported\) and Vulkan failed \(/)
    expect(notices[0]).toContain(cause)
    expect(notices[0]).toMatch(/; running on CPU\.$/)
    expect(setup.downloads).toEqual([
      "https://runtime.test/cuda",
      "https://runtime.test/cudart",
      "https://runtime.test/vulkan",
      "https://runtime.test/cpu",
    ])
    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" })
    await runtime.stop()
  })

  it("notices a CUDA probe failure with its cause when Vulkan takes over", async () => {
    const setup = await cudaRuntimeSetup()
    const notices: string[] = []
    setup.options.listDevices = async (path) => {
      if (path.includes("-cuda-")) throw new Error("libcuda.so.1: cannot open shared object file")
      return "Available devices:\n  Vulkan0: NVIDIA RTX"
    }
    const runtime = new LlamaCppRuntime(setup.options)
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware, {
      onNotice: (message) => notices.push(message),
    })
    expect(notices).toEqual([
      "CUDA failed (libcuda.so.1: cannot open shared object file); running on Vulkan.",
    ])
    expect(setup.commands).toEqual([
      join(setup.directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server"),
    ])
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
    expect(selectAsset).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "cuda", cudaVersion }),
      "prism",
    )
    expect(setup.commands).toEqual([
      join(
        setup.directory,
        "bin",
        `${PRISM_LLAMA_CPP_RELEASE_TAG}-cuda-${cudaVersion}`,
        "llama-server",
      ),
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
        path.includes("-cuda-")
          ? "Available devices:\n  (none)"
          : "Available devices:\n  Vulkan0: NVIDIA RTX",
    })
    await runtime.ensureServing(setup.model, setup.fit, setup.hardware)
    expect(setup.fit.model.quant).toBe("PQ2_0")
    expect(spawn.mock.calls[0]?.[1]).toContain(localGgufPath(fallback, setup.directory))
    expect(selectAsset).toHaveBeenLastCalledWith(
      expect.objectContaining({ backend: "vulkan" }),
      "prism",
    )
    expect(setup.commands).toEqual([
      join(setup.directory, "bin", PRISM_LLAMA_CPP_RELEASE_TAG, "llama-server"),
    ])
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
                {
                  ...packing.ggufFiles[0],
                  size: body.length,
                  sha256: createHash("sha256").update(body).digest("hex"),
                },
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
        failure === "probe"
          ? [fallbackPath]
          : [localGgufPath(model, setup.directory), fallbackPath],
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
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "HTTP 503",
    )
    expect(setup.commands).toEqual([])
    expect(runtime.serving).toBeUndefined()
    expect((await stat(localGgufPath(setup.model, setup.directory))).size).toBe(
      setup.model.ggufFiles[0].size,
    )
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
    expect(
      await readFile(join(setup.cudaDir, `libcublasLt.so.${cudaVersion.split(".")[0]}`), "utf8"),
    ).toBe("library")
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
      const extract = setup.options.extractArchive as NonNullable<
        LlamaCppRuntimeOptions["extractArchive"]
      >
      setup.options.extractArchive = async (archive, destination) => {
        await extract(archive, destination)
        if ((await readFile(archive, "utf8")) === "cudart")
          await rm(join(destination, "bundle", "libcublasLt.so.13"))
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
      if (failure === "loader error")
        throw new Error("libcuda.so.1: cannot open shared object file")
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
    expect(setup.commands).toEqual(
      Array(2).fill(join(setup.directory, "bin", LLAMA_CPP_RELEASE_TAG, "llama-server")),
    )
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
    await expect(runtime.ensureServing(setup.model, setup.fit, setup.hardware)).rejects.toThrow(
      "HTTP 404",
    )
    expect(await readFile(old, "utf8")).toBe("server")
    expect(setup.commands).toEqual([])
    await runtime.stop()
  })
})

async function cudaRuntimeSetup(
  cudaVersion: "12.8" | "13.3" = "13.3",
  runtime: LlamaRuntimeKind = "upstream",
) {
  const cudaHardware: HardwareProbe = {
    ...hardware,
    platform: "linux",
    arch: "x64",
    backend: "cuda",
    cudaVersion,
    unifiedMemory: false,
  }
  const spec =
    runtime === "prism" ? findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf") : catalogModel()
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
      target.backend === "cuda"
        ? { ...archive("cuda"), companion: archive("cudart") }
        : archive("vulkan"),
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
      if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
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
          ? ["libcudart", "libcublas", "libcublasLt"].map(
              (name) => `${name}.so.${cudaVersion.split(".")[0]}`,
            )
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

/** Also pins a Linux CPU archive, so the CUDA -> Vulkan -> CPU chain can finish. */
function cpuAwareRuntimeAsset(
  setup: Awaited<ReturnType<typeof cudaRuntimeSetup>>,
): NonNullable<LlamaCppRuntimeOptions["runtimeAsset"]> {
  const asset = setup.options.runtimeAsset
  if (!asset) throw new Error("missing fake runtime asset")
  return (target, runtime) =>
    target.backend === "cpu"
      ? {
          name: "cpu",
          url: "https://runtime.test/cpu",
          size: 3,
          sha256: createHash("sha256").update("cpu").digest("hex"),
        }
      : asset(target, runtime)
}

/** A model start with a recorded server from an earlier process, plus fake pid controls. */
async function orphanSetup(record: {
  ownerPid: number
  command: string
  alivePids?: readonly number[]
  /** Command lines of other live pids; 4242 always answers with `command`. */
  commands?: Record<number, string>
}) {
  const alive = new Set(record.alivePids ?? [4242])
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
  let recordBeforeSpawn: string | undefined
  const setup = await generationRuntimeSetup(async () => generationResponse(), {
    signalProcess: (pid, signal) => {
      if (!alive.has(pid)) throw esrch()
      if (signal === 0) return
      signals.push([pid, signal])
      alive.delete(pid)
    },
    processCommand: async (pid) =>
      !alive.has(pid) ? "" : pid === 4242 ? record.command : (record.commands?.[pid] ?? ""),
    // Port allocation runs after the stale record is handled and before the new one is written.
    allocatePort: async () => {
      recordBeforeSpawn = await readFile(
        join(setup.directory, "servers", `${record.ownerPid}.json`),
        "utf8",
      ).catch(() => "removed")
      return 18765
    },
  })
  await mkdir(join(setup.directory, "servers"), { recursive: true })
  await writeFile(
    join(setup.directory, "servers", `${record.ownerPid}.json`),
    JSON.stringify({
      pid: 4242,
      ownerPid: record.ownerPid,
      port: 18701,
      binaryPath: process.execPath,
      startedAt: new Date(0).toISOString(),
    }),
  )
  return { ...setup, signals, alive, recordBeforeSpawn: () => recordBeforeSpawn }
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-llama-"))
  tempDirectories.push(path)
  return path
}

async function generationRuntimeSetup(
  generationFetch: typeof fetch,
  overrides: Partial<LlamaCppRuntimeOptions> = {},
) {
  const model = catalogModel()
  const fit = fitLocalModel(model, hardware)
  const directory = await tempDir()
  await cacheWeights(model, directory)
  const children: ReturnType<typeof fakeChild>[] = []
  const runtime = new LlamaCppRuntime({
    env: { OTIS_LLAMA_SERVER: process.execPath },
    dataDirectory: directory,
    allocatePort: async () => 18765,
    spawn: (() => {
      const child = fakeChild()
      child.pid = 700 + children.length
      children.push(child)
      return child
    }) as unknown as LlamaCppRuntimeOptions["spawn"],
    fetch: (async (input, init) => {
      const url = String(input)
      if (url.endsWith("/health")) return new Response("ok")
      if (url.endsWith("/props")) return runtimeProperties(65_536)
      if (url.endsWith("/v1/chat/completions")) return await generationFetch(input, init)
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch,
    ...overrides,
  })
  return { runtime, model, fit, children, directory }
}

function pendingGeneration(signal: AbortSignal | undefined): Promise<Response> {
  if (!signal) throw new Error("Missing generation abort signal")
  signal.throwIfAborted()
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid?: number
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
    if (String(input).endsWith("/v1/chat/completions")) return generationResponse()
    if (url.includes("huggingface.co")) {
      return new Response(Buffer.from(body), {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      })
    }
    return new Response("missing", { status: 404 })
  }) as typeof fetch
}

function generationResponse(
  delta: Record<string, unknown> = { content: "Hello." },
  finishReason: string | null = "stop",
) {
  const chunk = JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function localGgufPath(model: LocalModelSpec, directory: string) {
  return join(directory, "models", model.ggufFiles[0].name)
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
