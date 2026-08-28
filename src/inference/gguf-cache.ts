import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { llamaModelCacheDirectory } from "../local/paths.js"
import { normalizedSha256, sha256File } from "./file-integrity.js"
import { LOCAL_MODELS, type LocalGgufFile, type LocalModelSpec, localModelWeightBytes } from "./local-catalog.js"

const DOWNLOAD_LOCK_POLL_MS = 250
const GGUF_MANIFEST_VERSION = 1

export function localGgufPath(model: LocalModelSpec, dataDirectory?: string) {
  return localGgufPaths(model, dataDirectory)[0]
}

export function localGgufPaths(model: LocalModelSpec, dataDirectory?: string) {
  const root = dataDirectory ? join(dataDirectory, "models") : llamaModelCacheDirectory()
  return model.ggufFiles.map((file) => join(root, file.name))
}

export function huggingFaceGgufUrl(model: LocalModelSpec, file: LocalGgufFile = model.ggufFiles[0]) {
  return `https://huggingface.co/${model.ggufRepo}/resolve/${model.ggufRevision}/${file.name}`
}

export async function isLocalGgufDownloaded(model: LocalModelSpec, dataDirectory?: string) {
  const states = await Promise.all(
    localGgufPaths(model, dataDirectory).map((path, index) => hasPinnedFileSize(path, model.ggufFiles[index].size)),
  )
  return states.every(Boolean)
}

export async function listDownloadedLocalModels(dataDirectory?: string) {
  const downloaded = await Promise.all(
    LOCAL_MODELS.map(async (model) => ((await isLocalGgufDownloaded(model, dataDirectory)) ? model : undefined)),
  )
  return downloaded.filter((model): model is LocalModelSpec => model !== undefined)
}

export async function deleteLocalGguf(model: LocalModelSpec, dataDirectory?: string) {
  const destinations = localGgufPaths(model, dataDirectory)
  const primary = destinations[0]
  await mkdir(dirname(primary), { recursive: true, mode: 0o700 })
  const releaseLock = await acquireDownloadLock(lockPath(primary))
  try {
    await Promise.all(
      destinations.flatMap((dest) => [
        rm(dest, { force: true }),
        rm(manifestPath(dest), { force: true }),
        rm(partialPath(dest), { force: true }),
      ]),
    )
  } finally {
    await releaseLock()
  }
}

export type DownloadGgufOptions = {
  dataDirectory?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

export async function ensureLocalGguf(model: LocalModelSpec, options: DownloadGgufOptions = {}) {
  const destinations = localGgufPaths(model, options.dataDirectory)
  const primary = destinations[0]
  const totalBytes = localModelWeightBytes(model)
  await mkdir(dirname(primary), { recursive: true, mode: 0o700 })
  const releaseLock = await acquireDownloadLock(lockPath(primary), options.signal)
  try {
    let completedBytes = 0
    let lastPercent = -1
    for (const [index, pinnedFile] of model.ggufFiles.entries()) {
      const dest = destinations[index]
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await ensureGgufFile(model, pinnedFile, dest, options, (fileBytes) => {
        const percent = downloadPercent(completedBytes + fileBytes, totalBytes)
        if (percent !== lastPercent) {
          lastPercent = percent
          options.onProgress?.(percent)
        }
      })
      completedBytes += pinnedFile.size
    }
    if (lastPercent !== 100) options.onProgress?.(100)
    return primary
  } finally {
    await releaseLock()
  }
}

async function ensureGgufFile(
  model: LocalModelSpec,
  pinnedFile: LocalGgufFile,
  dest: string,
  options: DownloadGgufOptions,
  onReceived: (bytes: number) => void,
) {
  const expectedSha256 = normalizedSha256(pinnedFile.sha256)
  if (await isVerifiedGguf(dest, model, pinnedFile, expectedSha256)) {
    onReceived(pinnedFile.size)
    return
  }

  const partial = partialPath(dest)
  const resumedBytes = await validPartialSize(partial, pinnedFile.size, expectedSha256)
  if (resumedBytes === pinnedFile.size) {
    await publishGguf(partial, dest, model, pinnedFile, expectedSha256)
    onReceived(pinnedFile.size)
    return
  }

  options.signal?.throwIfAborted()
  const headers: Record<string, string> = { "user-agent": "otis" }
  const token = huggingFaceToken(options.env ?? process.env)
  if (token) headers.authorization = `Bearer ${token}`
  if (resumedBytes > 0) headers.range = `bytes=${resumedBytes}-`

  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(huggingFaceGgufUrl(model, pinnedFile), {
    headers,
    signal: options.signal,
    redirect: "follow",
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${model.displayName} (HTTP ${response.status}).`)
  }

  const append = resumedBytes > 0 && response.status === 206
  const start = append ? resumedBytes : 0
  validateDownloadResponse(response, start, model, pinnedFile)
  const hash = createHash("sha256")
  if (start > 0) await updateHashFromFile(hash, partial)
  const file = await open(partial, append ? "a" : "w", 0o600)
  let received = start
  let closed = false
  let discardPartial = false
  onReceived(received)
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      options.signal?.throwIfAborted()
      if (!value || value.byteLength === 0) continue
      if (received + value.byteLength > pinnedFile.size) {
        discardPartial = true
        throw new Error(`Could not download ${model.displayName}: the response exceeded the pinned file size.`)
      }
      await file.writeFile(value)
      hash.update(value)
      received += value.byteLength
      onReceived(received)
    }
    options.signal?.throwIfAborted()
    if (received !== pinnedFile.size) {
      throw new Error(
        `Could not download ${model.displayName}: expected ${pinnedFile.size} bytes but received ${received}.`,
      )
    }
    const actualSha256 = hash.digest("hex")
    if (actualSha256 !== expectedSha256) {
      discardPartial = true
      throw new Error(`Could not download ${model.displayName}: SHA-256 verification failed.`)
    }
    await file.close()
    closed = true
    await publishGguf(partial, dest, model, pinnedFile, expectedSha256)
  } finally {
    if (!closed) await file.close().catch(() => undefined)
    if (discardPartial) await rm(partial, { force: true }).catch(() => undefined)
  }
}

async function hasPinnedFileSize(path: string, expectedBytes: number) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size === expectedBytes
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function isVerifiedGguf(dest: string, model: LocalModelSpec, pinnedFile: LocalGgufFile, expectedSha256: string) {
  try {
    const info = await stat(dest)
    if (!info.isFile() || info.size !== pinnedFile.size) return false
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
  if (await hasMatchingManifest(dest, model, pinnedFile, expectedSha256)) return true
  if ((await sha256File(dest)) !== expectedSha256) return false
  await writeGgufManifest(dest, model, pinnedFile, expectedSha256)
  return true
}

async function validPartialSize(partial: string, expectedBytes: number, expectedSha256: string) {
  try {
    const info = await stat(partial)
    if (!info.isFile() || info.size > expectedBytes) {
      await rm(partial, { force: true })
      return 0
    }
    if (info.size === expectedBytes && (await sha256File(partial)) !== expectedSha256) {
      await rm(partial, { force: true })
      return 0
    }
    return info.size
  } catch (error) {
    if (isNotFound(error)) return 0
    throw error
  }
}

function validateDownloadResponse(response: Response, start: number, model: LocalModelSpec, pinnedFile: LocalGgufFile) {
  if (start > 0) {
    const contentRange = response.headers.get("content-range")
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (
      !match ||
      Number(match[1]) !== start ||
      Number(match[2]) !== pinnedFile.size - 1 ||
      Number(match[3]) !== pinnedFile.size
    ) {
      throw new Error(`Could not resume ${model.displayName}: the server returned an invalid byte range.`)
    }
  }
  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
  const expectedResponseBytes = pinnedFile.size - start
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new Error(`Could not download ${model.displayName}: the server returned an invalid content length.`)
  }
  if (contentLength !== undefined && contentLength !== expectedResponseBytes) {
    throw new Error(
      `Could not download ${model.displayName}: expected ${expectedResponseBytes} response bytes but received ${contentLength}.`,
    )
  }
}

async function publishGguf(
  partial: string,
  dest: string,
  model: LocalModelSpec,
  pinnedFile: LocalGgufFile,
  expectedSha256: string,
) {
  await rename(partial, dest)
  await writeGgufManifest(dest, model, pinnedFile, expectedSha256)
}

async function hasMatchingManifest(
  dest: string,
  model: LocalModelSpec,
  pinnedFile: LocalGgufFile,
  expectedSha256: string,
) {
  try {
    const value = JSON.parse(await readFile(manifestPath(dest), "utf8")) as Record<string, unknown>
    return (
      value.version === GGUF_MANIFEST_VERSION &&
      value.model === model.id &&
      value.revision === model.ggufRevision &&
      value.sha256 === expectedSha256 &&
      value.size === pinnedFile.size
    )
  } catch {
    return false
  }
}

async function writeGgufManifest(
  dest: string,
  model: LocalModelSpec,
  pinnedFile: LocalGgufFile,
  expectedSha256: string,
) {
  const path = manifestPath(dest)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: GGUF_MANIFEST_VERSION,
        model: model.id,
        revision: model.ggufRevision,
        sha256: expectedSha256,
        size: pinnedFile.size,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function updateHashFromFile(hash: ReturnType<typeof createHash>, path: string) {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
}

function downloadPercent(received: number, total: number) {
  return Math.min(100, Math.floor((received / total) * 100))
}

function partialPath(dest: string) {
  return `${dest}.partial`
}

function manifestPath(dest: string) {
  return `${dest}.otis.json`
}

function lockPath(dest: string) {
  return `${dest}.download.lock`
}

async function acquireDownloadLock(path: string, signal?: AbortSignal) {
  for (;;) {
    signal?.throwIfAborted()
    try {
      const handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8")
      } catch (error) {
        await rm(path, { force: true })
        throw error
      } finally {
        await handle.close().catch(() => undefined)
      }
      return async () => {
        await rm(path, { force: true })
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await isStaleLock(path)) {
        await rm(path, { force: true })
        continue
      }
      await abortableDelay(DOWNLOAD_LOCK_POLL_MS, signal)
    }
  }
}

async function isStaleLock(path: string) {
  try {
    const contents = await readFile(path, "utf8")
    let value: { pid?: unknown }
    try {
      value = JSON.parse(contents) as { pid?: unknown }
    } catch {
      const info = await stat(path)
      return Date.now() - info.mtimeMs > 5_000
    }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return true
    try {
      process.kill(Number(value.pid), 0)
      return false
    } catch (error) {
      return !isPermissionDenied(error)
    }
  } catch (error) {
    if (isNotFound(error)) return true
    throw error
  }
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      return
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    }
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function huggingFaceToken(env: NodeJS.ProcessEnv) {
  return env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim() || undefined
}

function isNotFound(error: unknown) {
  return errorCode(error) === "ENOENT"
}

function isAlreadyExists(error: unknown) {
  return errorCode(error) === "EEXIST"
}

function isPermissionDenied(error: unknown) {
  return errorCode(error) === "EPERM"
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}
