import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  deleteLocalGguf,
  ensureLocalGguf,
  huggingFaceGgufUrl,
  isLocalGgufDownloaded,
  listDownloadedLocalModels,
  localGgufPath,
} from "../../src/inference/gguf-cache.js"
import { findLocalModel } from "../../src/inference/local-catalog.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("local GGUF cache", () => {
  it("downloads the Hugging Face file with percent progress", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const percents: number[] = []
    const body = new Uint8Array([1, 2, 3, 4])
    const dest = await ensureLocalGguf(model, {
      dataDirectory: directory,
      fetch: (async () =>
        new Response(Buffer.from(body), {
          status: 200,
          headers: { "content-length": String(body.byteLength) },
        })) as typeof fetch,
      onProgress: (percent) => percents.push(percent),
    })

    expect(dest).toBe(localGgufPath(model, directory))
    expect(await readFile(dest)).toEqual(Buffer.from(body))
    expect(percents.at(-1)).toBe(100)
    expect(await isLocalGgufDownloaded(model, directory)).toBe(true)
  })

  it("skips the network when the GGUF is already on disk", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const dest = localGgufPath(model, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(dest, "cached")
    let fetched = false
    await ensureLocalGguf(model, {
      dataDirectory: directory,
      fetch: (async () => {
        fetched = true
        return new Response("no", { status: 500 })
      }) as typeof fetch,
    })
    expect(fetched).toBe(false)
    expect(await readFile(dest, "utf8")).toBe("cached")
  })

  it("lists and deletes only completed local model files", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(localGgufPath(model, directory), "cached")
    await writeFile(`${localGgufPath(model, directory)}.partial`, "unfinished")

    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([model])
    await deleteLocalGguf(model, directory)
    await deleteLocalGguf(model, directory)
    await expect(listDownloadedLocalModels(directory)).resolves.toEqual([])
    await expect(readFile(`${localGgufPath(model, directory)}.partial`, "utf8")).resolves.toBe("unfinished")
  })

  it("deletes a partial file when the download is aborted", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        abort.abort()
      },
    })
    await expect(
      ensureLocalGguf(model, {
        dataDirectory: directory,
        signal: abort.signal,
        fetch: (async () => new Response(body, { status: 200, headers: { "content-length": "4" } })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })

    await expect(stat(`${localGgufPath(model, directory)}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await isLocalGgufDownloaded(model, directory)).toBe(false)
  })

  it("publishes concurrent downloads from isolated partial files", async () => {
    const model = catalogModel()
    const directory = await tempDir()
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = []
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodies.push(controller)
          },
        }),
        { status: 200, headers: { "content-length": "2" } },
      )) as typeof fetch

    const first = ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    const second = ensureLocalGguf(model, { dataDirectory: directory, fetch: fetchImpl })
    await vi.waitFor(() => expect(bodies).toHaveLength(2))

    bodies[0]?.enqueue(new Uint8Array([1, 2]))
    bodies[0]?.close()
    bodies[1]?.enqueue(new Uint8Array([1, 2]))
    bodies[1]?.close()
    await Promise.all([first, second])

    expect(await readFile(localGgufPath(model, directory))).toEqual(Buffer.from([1, 2]))
    expect((await readdir(join(directory, "models"))).filter((name) => name.endsWith(".partial"))).toEqual([])
  })

  it("builds the official Hugging Face resolve URL", () => {
    const model = catalogModel()
    expect(huggingFaceGgufUrl(model)).toBe(`https://huggingface.co/${model.ggufRepo}/resolve/main/${model.ggufFile}`)
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-gguf-"))
  tempDirectories.push(path)
  return path
}

function catalogModel() {
  const model = findLocalModel("openai/gpt-oss-20b")
  if (!model) throw new Error("missing catalog entry")
  return model
}
