import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cloneLocalGguf,
  deleteLocalGguf,
  ensureLocalGguf,
  isLocalGgufDownloaded,
  listDownloadedLocalModels,
} from "../../src/inference/gguf-cache.js"
import {
  findLocalModel,
  type LocalModelSpec,
  localModelPackings,
} from "../../src/inference/local-catalog.js"

const tempDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("local GGUF cache", () => {
  it("clones verified weights without network access or sharing writable files", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const source = await tempDir()
    const destination = await tempDir()
    const original = await ensureLocalGguf(model, { dataDirectory: source, fetch: response(body) })
    await cloneLocalGguf(model, source, destination)

    const fetchImpl = vi.fn(() => {
      throw new Error("unexpected network access")
    })
    const cloned = await ensureLocalGguf(model, { dataDirectory: destination, fetch: fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await readFile(cloned)).toEqual(Buffer.from(body))
    expect((await stat(cloned)).ino).not.toBe((await stat(original)).ino)
    if (process.platform !== "win32") expect((await stat(cloned)).mode & 0o777).toBe(0o600)
    await writeFile(cloned, new Uint8Array([9, 9, 9, 9]))
    expect(await readFile(original)).toEqual(Buffer.from(body))
    await deleteLocalGguf(model, destination)
    expect(await isLocalGgufDownloaded(model, source)).toBe(true)
    expect(await readFile(original)).toEqual(Buffer.from(body))
  })

  it("imports every completed shard but not partial downloads", async () => {
    const bodies = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const model = splitModel(bodies)
    const source = await tempDir()
    const destination = await tempDir()
    const paths = localGgufPaths(model, source)
    await mkdir(join(source, "models", "split"), { recursive: true })
    await writeFile(paths[0], bodies[0])
    await writeFile(`${paths[1]}.partial`, bodies[1])
    await cloneLocalGguf(model, source, destination)
    await expect(stat(localGgufPath(model, destination))).rejects.toMatchObject({ code: "ENOENT" })

    await writeFile(paths[1], bodies[1])
    await cloneLocalGguf(model, source, destination)
    for (const [index, path] of localGgufPaths(model, destination).entries()) {
      expect(await readFile(path)).toEqual(Buffer.from(bodies[index]))
      await expect(stat(`${path}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
    }
    await deleteLocalGguf(model, source)
    expect(await isLocalGgufDownloaded(model, destination)).toBe(true)
  })

  it("preserves existing dev weights and does not bless them with the source manifest", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const source = await tempDir()
    const destination = await tempDir()
    await ensureLocalGguf(model, { dataDirectory: source, fetch: response(body) })
    const dest = localGgufPath(model, destination)
    await mkdir(join(destination, "models"))
    await writeFile(dest, "keep")
    await cloneLocalGguf(model, source, destination)
    expect(await readFile(dest, "utf8")).toBe("keep")
    await expect(stat(`${dest}.otis.json`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not treat unverified cloned weights as verified", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const source = await tempDir()
    const destination = await tempDir()
    const original = localGgufPath(model, source)
    await mkdir(join(source, "models"))
    await writeFile(original, "nope")
    await cloneLocalGguf(model, source, destination)
    const fetchImpl = vi.fn(response(body))
    const cloned = await ensureLocalGguf(model, { dataDirectory: destination, fetch: fetchImpl })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(await readFile(cloned)).toEqual(Buffer.from(body))
    expect(await readFile(original, "utf8")).toBe("nope")
    await expect(stat(`${original}.otis.json`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("downloads and verifies the pinned Hugging Face file with percent progress", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const percents: number[] = []
    const fetchImpl = vi.fn(response(body))
    const dest = await ensureLocalGguf(model, {
      dataDirectory: directory,
      fetch: fetchImpl,
      onProgress: (percent) => percents.push(percent),
    })

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `https://huggingface.co/${model.ggufRepo}/resolve/${model.ggufRevision}/tiny.gguf`,
    )
    expect(dest).toBe(localGgufPath(model, directory))
    expect(await readFile(dest)).toEqual(Buffer.from(body))
    expect(percents.at(-1)).toBe(100)
    expect(await isLocalGgufDownloaded(model, directory)).toBe(true)
    await expect(readFile(`${dest}.otis.json`, "utf8")).resolves.toContain(
      model.ggufFiles[0].sha256,
    )
  })

  it("verifies a legacy cached GGUF once and then skips the network", async () => {
    const body = new Uint8Array([4, 3, 2, 1])
    const model = tinyModel(body)
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(dest, body)
    const fetchImpl = vi.fn(
      async () => new Response("no", { status: 500 }),
    ) as unknown as typeof fetch

    await ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    await ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })

    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(readFile(`${dest}.otis.json`, "utf8")).resolves.toContain(model.ggufRevision)
  })

  it("replaces a same-size cached file whose checksum is wrong", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(dest, new Uint8Array([9, 9, 9, 9]))

    await ensureLocalGguf(model, { dataDirectory: directory, fetch: response(body) })

    expect(await readFile(dest)).toEqual(Buffer.from(body))
  })

  it("resumes a partial download with an exact byte range", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6])
    const model = tinyModel(body)
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(`${dest}.partial`, body.slice(0, 3))
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=3-")
      return new Response(body.slice(3), {
        status: 206,
        headers: { "content-length": "3", "content-range": "bytes 3-5/6" },
      })
    }) as unknown as typeof fetch

    await ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(await readFile(dest)).toEqual(Buffer.from(body))
    await expect(stat(`${dest}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("restarts cleanly when a server ignores the requested range", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(`${dest}.partial`, body.slice(0, 2))

    await ensureLocalGguf(model, { dataDirectory: directory, fetch: response(body) })

    expect(await readFile(dest)).toEqual(Buffer.from(body))
  })

  it("rejects a resumed response that does not cover the exact remaining range", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const partial = `${localGgufPath(model, directory)}.partial`
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(partial, body.slice(0, 2))

    await expect(
      ensureLocalGguf(model, {
        dataDirectory: directory,
        fetch: (async () =>
          new Response(body.slice(2), {
            status: 206,
            headers: { "content-length": "2", "content-range": "bytes 2-2/4" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("invalid byte range")
    await expect(readFile(partial)).resolves.toEqual(Buffer.from(body.slice(0, 2)))
  })

  it("retains a partial file when the download is aborted", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const abort = new AbortController()
    await expect(
      ensureLocalGguf(model, {
        dataDirectory: directory,
        signal: abort.signal,
        fetch: response(body.slice(0, 2), model.ggufFiles[0].size),
        onProgress: (percent) => {
          if (percent === 50) abort.abort()
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })

    await expect(readFile(`${localGgufPath(model, directory)}.partial`)).resolves.toEqual(
      Buffer.from([1, 2]),
    )
    expect(await isLocalGgufDownloaded(model, directory)).toBe(false)
  })

  it("fails before downloading when the cache volume lacks space for the remaining bytes", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6])
    const model = tinyModel(body)
    const directory = await tempDir()
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(`${localGgufPath(model, directory)}.partial`, body.slice(0, 2))
    const fetchImpl = vi.fn(response(body))
    const statfs = vi.fn(async () => ({ bavail: 3n, bsize: 1 }))

    await expect(
      ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl, statfs }),
    ).rejects.toThrow(
      `Not enough disk space to download ${model.displayName}: 0.0 GB needed, 0.0 GB available ` +
        `in ${join(directory, "models")}.`,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(statfs).toHaveBeenCalledWith(join(directory, "models"))

    // The four bytes still missing fit; the cached prefix is not counted again.
    statfs.mockResolvedValue({ bavail: 4n, bsize: 1 })
    await ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl, statfs })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(await isLocalGgufDownloaded(model, directory)).toBe(true)

    // A verified cache needs no space and no probe.
    statfs.mockClear()
    await ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl, statfs })
    expect(statfs).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("reports the shortfall in gigabytes", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await expect(
      ensureLocalGguf(model, {
        dataDirectory: directory,
        fetch: vi.fn() as unknown as typeof fetch,
        statfs: async () => ({ bavail: 3, bsize: 1024 ** 3 }),
      }),
    ).rejects.toThrow(
      `${(model.ggufFiles[0].size / 1024 ** 3).toFixed(1)} GB needed, 3.0 GB available`,
    )
  })

  it("takes over a download lock whose holder stopped refreshing it, even with a live pid", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const lock = `${localGgufPath(model, directory)}.download.lock`
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: "2020-01-01" })}\n`)
    const stale = new Date(Date.now() - 61_000)
    await utimes(lock, stale, stale)

    await ensureLocalGguf(model, { dataDirectory: directory, fetch: response(body) })

    expect(await isLocalGgufDownloaded(model, directory)).toBe(true)
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps waiting on a lock that a live holder refreshed recently", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const lock = `${localGgufPath(model, directory)}.download.lock`
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: "2020-01-01" })}\n`)
    const fetchImpl = vi.fn(response(body))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 600)

    await expect(
      ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl, signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(stat(lock)).resolves.toBeDefined()
  })

  it("refreshes the download lock while bytes are still arriving", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const body = new Uint8Array([1, 2])
    const model = tinyModel(body)
    const directory = await tempDir()
    const lock = `${localGgufPath(model, directory)}.download.lock`
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
        }),
        { status: 200, headers: { "content-length": "2" } },
      )) as typeof fetch

    const download = ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    await vi.waitFor(() => expect(stream).toBeDefined())
    const stale = new Date(Date.now() - 61_000)
    await utimes(lock, stale, stale)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(async () => {
      expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(10_000)
    })

    stream?.enqueue(body)
    stream?.close()
    await download
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("serializes concurrent callers and publishes one verified download", async () => {
    const body = new Uint8Array([1, 2])
    const model = tinyModel(body)
    const directory = await tempDir()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
            },
          }),
          { status: 200, headers: { "content-length": "2" } },
        ),
    ) as unknown as typeof fetch

    const first = ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    const second = ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    await vi.waitFor(() => expect(stream).toBeDefined())
    stream?.enqueue(body)
    stream?.close()
    await Promise.all([first, second])

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(await readFile(localGgufPath(model, directory))).toEqual(Buffer.from(body))
  })

  it("rejects and removes a completed partial whose checksum is wrong", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const model = tinyModel(body)
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)

    await expect(
      ensureLocalGguf(model, {
        dataDirectory: directory,
        fetch: response(new Uint8Array([4, 3, 2, 1])),
      }),
    ).rejects.toThrow("SHA-256 verification failed")
    await expect(stat(`${dest}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await isLocalGgufDownloaded(model, directory)).toBe(false)
  })

  it("lists completed catalog files and deletes their data and partial state", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(dest, "")
    await truncate(dest, model.ggufFiles[0].size)
    await writeFile(`${dest}.partial`, "unfinished")
    await writeFile(`${dest}.otis.json`, "manifest")

    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([model])
    await deleteLocalGguf(model, directory)
    await deleteLocalGguf(model, directory)
    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([])
    await expect(stat(`${dest}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(`${dest}.otis.json`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("discovers and deletes every cached packing of one model", async () => {
    const model = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!model) throw new Error("missing Bonsai catalog entry")
    const directory = await tempDir()
    await mkdir(join(directory, "models"), { recursive: true })
    const paths = localModelPackings(model).map((packing) => localGgufPath(packing, directory))
    for (const [index, path] of paths.entries()) {
      await writeFile(path, "")
      await truncate(path, model.packings?.[index]?.ggufFiles[0].size ?? 0)
      await writeFile(`${path}.partial`, "unfinished")
      await writeFile(`${path}.otis.json`, "manifest")
    }

    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([
      expect.objectContaining({ id: model.id, quant: "PTQ1_0" }),
    ])
    await deleteLocalGguf(model, directory)

    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([])
    for (const path of paths) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(`${path}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(`${path}.otis.json`)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  it("downloads, verifies, and deletes every shard in a split GGUF", async () => {
    const shards = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const model = splitModel(shards)
    const directory = await tempDir()
    const percents: number[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const index = model.ggufFiles.findIndex((file) => String(input).endsWith(file.name))
      const body = shards[index]
      if (!body) return new Response("missing", { status: 404 })
      return new Response(Buffer.from(body), {
        headers: { "content-length": String(body.byteLength) },
      })
    }) as unknown as typeof fetch

    const primary = await ensureLocalGguf(model, {
      dataDirectory: directory,
      fetch: fetchImpl,
      onProgress: (percent) => percents.push(percent),
    })
    const paths = localGgufPaths(model, directory)

    expect(primary).toBe(paths[0])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await expect(readFile(paths[0])).resolves.toEqual(Buffer.from(shards[0]))
    await expect(readFile(paths[1])).resolves.toEqual(Buffer.from(shards[1]))
    expect(percents.at(-1)).toBe(100)
    await expect(isLocalGgufDownloaded(model, directory)).resolves.toBe(true)

    await deleteLocalGguf(model, directory)
    await expect(isLocalGgufDownloaded(model, directory)).resolves.toBe(false)
    await expect(stat(paths[0])).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(paths[1])).rejects.toMatchObject({ code: "ENOENT" })
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-gguf-"))
  tempDirectories.push(path)
  return path
}

function localGgufPaths(model: LocalModelSpec, directory: string) {
  return model.ggufFiles.map((file) => join(directory, "models", file.name))
}

function localGgufPath(model: LocalModelSpec, directory: string) {
  return localGgufPaths(model, directory)[0]
}

function catalogModel() {
  const model = findLocalModel("openai/gpt-oss-20b")
  if (!model) throw new Error("missing catalog entry")
  return model
}

function tinyModel(body: Uint8Array): LocalModelSpec {
  return {
    ...catalogModel(),
    ggufFiles: [
      {
        name: "tiny.gguf",
        size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ],
  }
}

function splitModel(shards: readonly Uint8Array[]): LocalModelSpec {
  const files = shards.map((body, index) => ({
    name: `split/model-${index + 1}-of-${shards.length}.gguf`,
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  }))
  const first = files[0]
  if (!first) throw new Error("split model needs at least one shard")
  return { ...catalogModel(), ggufFiles: [first, ...files.slice(1)] }
}

function response(body: Uint8Array, contentLength = body.byteLength): typeof fetch {
  return (async () =>
    new Response(Buffer.from(body), {
      status: 200,
      headers: { "content-length": String(contentLength) },
    })) as typeof fetch
}
