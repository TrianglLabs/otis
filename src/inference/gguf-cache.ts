import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { llamaModelCacheDirectory } from "../local/paths.js"
import {
  LOCAL_MODELS,
  type LocalGgufFile,
  type LocalModelSpec,
  localModelPackings,
  localModelWeightBytes,
} from "./local-catalog.js"

const DOWNLOAD_LOCK_POLL_MS = 250
/** A live holder refreshes the lock's mtime; after a reboot its pid may belong to anything. */
const DOWNLOAD_LOCK_HEARTBEAT_MS = 15_000
const DOWNLOAD_LOCK_STALE_MS = 60_000
const GGUF_MANIFEST_VERSION = 1

function localGgufPaths(model: LocalModelSpec, dataDirectory?: string) {
  const root = dataDirectory ? join(dataDirectory, "models") : llamaModelCacheDirectory()
  return model.ggufFiles.map((file) => join(root, file.name))
}

export async function isLocalGgufDownloaded(model: LocalModelSpec, dataDirectory?: string) {
  const states = await Promise.all(
    localGgufPaths(model, dataDirectory).map((path, index) =>
      hasPinnedFileSize(path, model.ggufFiles[index].size),
    ),
  )
  return states.every(Boolean)
}

export async function isAnyLocalModelPackingDownloaded(
  model: LocalModelSpec,
  dataDirectory?: string,
) {
  return (await downloadedLocalPacking(model, dataDirectory)) !== undefined
}

export async function listDownloadedLocalModels(dataDirectory?: string) {
  const downloaded = await Promise.all(
    LOCAL_MODELS.map((model) => downloadedLocalPacking(model, dataDirectory)),
  )
  return downloaded.filter((model): model is LocalModelSpec => model !== undefined)
}

async function downloadedLocalPacking(model: LocalModelSpec, dataDirectory?: string) {
  for (const packing of localModelPackings(model)) {
    if (await isLocalGgufDownloaded(packing, dataDirectory)) return packing
  }
  return undefined
}

export async function deleteLocalGguf(model: LocalModelSpec, dataDirectory?: string) {
  const packings = localModelPackings(model)
  const destinations = [
    ...new Set(packings.flatMap((packing) => localGgufPaths(packing, dataDirectory))),
  ]
  const primaries = [
    ...new Set(packings.map((packing) => localGgufPaths(packing, dataDirectory)[0])),
  ].sort()
  await Promise.all(
    primaries.map((primary) => mkdir(dirname(primary), { recursive: true, mode: 0o700 })),
  )
  const releaseLocks: Array<() => Promise<void>> = []
  try {
    for (const primary of primaries) releaseLocks.push(await acquireDownloadLock(lockPath(primary)))
    await Promise.all(
      destinations.flatMap((dest) => [
        rm(dest, { force: true }),
        rm(manifestPath(dest), { force: true }),
        rm(partialPath(dest), { force: true }),
      ]),
    )
  } finally {
    for (const release of releaseLocks.reverse()) await release()
  }
}

/**
 * Reuse a complete download in another profile, with independently writable and deletable
 * files.
 */
export async function cloneLocalGguf(
  model: LocalModelSpec,
  sourceDirectory: string,
  dataDirectory: string,
) {
  if (!(await isLocalGgufDownloaded(model, sourceDirectory))) return
  const sources = localGgufPaths(model, sourceDirectory)
  const destinations = localGgufPaths(model, dataDirectory)
  await mkdir(dirname(destinations[0]), { recursive: true, mode: 0o700 })
  const releaseLock = await acquireDownloadLock(lockPath(destinations[0]))
  try {
    for (const [index, file] of model.ggufFiles.entries()) {
      const dest = destinations[index]
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      try {
        await stat(dest)
        continue
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      const temporary = `${dest}.${process.pid}.${randomUUID()}.tmp`
      try {
        // Reflink where supported; otherwise a local copy. Never share writable inodes or
        // cache directories.
        await copyFile(
          sources[index],
          temporary,
          constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
        )
        await chmod(temporary, 0o600)
        if (!(await hasPinnedFileSize(temporary, file.size))) continue
        await link(temporary, dest)
        const sha256 = normalizedSha256(file.sha256)
        if (await hasMatchingManifest(sources[index], model, file, sha256)) {
          await writeGgufManifest(dest, model, file, sha256)
        }
        // Without a matching manifest, the usual load path verifies the clone's hash before
        // using it.
      } catch (error) {
        // The installed app may remove a source while it is being copied; never recreate it there.
        if (!isNotFound(error) && !isAlreadyExists(error)) throw error
      } finally {
        await rm(temporary, { force: true })
      }
    }
  } finally {
    await releaseLock()
  }
}

type DownloadGgufOptions = {
  dataDirectory?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
}

export async function ensureLocalGguf(model: LocalModelSpec, options: DownloadGgufOptions = {}) {
  const destinations = localGgufPaths(model, options.dataDirectory)
  const totalBytes = localModelWeightBytes(model)
  await mkdir(dirname(destinations[0]), { recursive: true, mode: 0o700 })
  const releaseLock = await acquireDownloadLock(lockPath(destinations[0]), options.signal)
  try {
    // Verify every file first so the space check counts only bytes still to download.
    const pending: Array<{ dest: string; partial: string; resumedBytes: number }> = []
    for (const [index, pinnedFile] of model.ggufFiles.entries()) {
      const dest = destinations[index]
      const expectedSha256 = normalizedSha256(pinnedFile.sha256)
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      let verified = await hasPinnedFileSize(dest, pinnedFile.size)
      if (verified && !(await hasMatchingManifest(dest, model, pinnedFile, expectedSha256))) {
        verified = (await sha256File(dest)) === expectedSha256
        if (verified) await writeGgufManifest(dest, model, pinnedFile, expectedSha256)
      }
      if (verified) continue
      const partial = partialPath(dest)
      let resumedBytes = 0
      try {
        const info = await stat(partial)
        resumedBytes = info.isFile() && info.size <= pinnedFile.size ? info.size : -1
        if (resumedBytes === pinnedFile.size && (await sha256File(partial)) !== expectedSha256)
          resumedBytes = -1
        if (resumedBytes < 0) {
          await rm(partial, { force: true })
          resumedBytes = 0
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      pending.push({ dest, partial, resumedBytes })
    }
    const neededBytes = pending.reduce(
      (sum, { dest, resumedBytes }) =>
        sum + model.ggufFiles[destinations.indexOf(dest)].size - resumedBytes,
      0,
    )
    if (neededBytes > 0) {
      const directory = dirname(destinations[0])
      const space = await (options.statfs ?? statfs)(directory)
      const availableBytes = Number(space.bavail) * Number(space.bsize)
      if (availableBytes < neededBytes) {
        const gigabytes = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
        throw new Error(
          `Not enough disk space to download ${model.displayName}: ${gigabytes(neededBytes)} GB ` +
            `needed, ${gigabytes(availableBytes)} GB available in ${directory}.`,
        )
      }
    }

    let completedBytes = 0
    let lastPercent = -1
    const report = (fileBytes: number) => {
      const percent = Math.min(100, Math.floor(((completedBytes + fileBytes) / totalBytes) * 100))
      if (percent === lastPercent) return
      lastPercent = percent
      options.onProgress?.(percent)
    }
    for (const [index, pinnedFile] of model.ggufFiles.entries()) {
      const dest = destinations[index]
      const work = pending.find((entry) => entry.dest === dest)
      if (work) {
        const expectedSha256 = normalizedSha256(pinnedFile.sha256)
        if (work.resumedBytes !== pinnedFile.size) {
          await downloadGgufFile(
            model,
            pinnedFile,
            work.partial,
            work.resumedBytes,
            expectedSha256,
            options,
            report,
          )
        }
        await rename(work.partial, dest)
        await writeGgufManifest(dest, model, pinnedFile, expectedSha256)
      }
      completedBytes += pinnedFile.size
      report(0)
    }
    if (lastPercent !== 100) options.onProgress?.(100)
    return destinations[0]
  } finally {
    await releaseLock()
  }
}

/**
 * Stream the pinned file into `partial`, appending to a verified prefix of `resumedBytes` when
 * the server honors the range.
 */
async function downloadGgufFile(
  model: LocalModelSpec,
  pinnedFile: LocalGgufFile,
  partial: string,
  resumedBytes: number,
  expectedSha256: string,
  options: DownloadGgufOptions,
  onReceived: (bytes: number) => void,
) {
  options.signal?.throwIfAborted()
  const env = options.env ?? process.env
  const headers: Record<string, string> = { "user-agent": "otis" }
  const token = env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim()
  if (token) headers.authorization = `Bearer ${token}`
  if (resumedBytes > 0) headers.range = `bytes=${resumedBytes}-`
  const response = await (options.fetch ?? fetch)(
    `https://huggingface.co/${model.ggufRepo}/resolve/${model.ggufRevision}/${pinnedFile.name}`,
    { headers, signal: options.signal, redirect: "follow" },
  )
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${model.displayName} (HTTP ${response.status}).`)
  }

  const start = resumedBytes > 0 && response.status === 206 ? resumedBytes : 0
  if (start > 0) {
    const match = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (
      !match ||
      Number(match[1]) !== start ||
      Number(match[2]) !== pinnedFile.size - 1 ||
      Number(match[3]) !== pinnedFile.size
    ) {
      throw new Error(
        `Could not resume ${model.displayName}: the server returned an invalid byte range.`,
      )
    }
  }
  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new Error(
      `Could not download ${model.displayName}: the server returned an invalid content length.`,
    )
  }
  if (contentLength !== undefined && contentLength !== pinnedFile.size - start) {
    throw new Error(
      `Could not download ${model.displayName}: expected ${pinnedFile.size - start} response bytes but received ${contentLength}.`,
    )
  }

  const hash = createHash("sha256")
  if (start > 0) for await (const chunk of createReadStream(partial)) hash.update(chunk)
  const file = await open(partial, start > 0 ? "a" : "w", 0o600)
  let received = start
  let discardPartial = false
  onReceived(received)
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      options.signal?.throwIfAborted()
      if (!value?.byteLength) continue
      if (received + value.byteLength > pinnedFile.size) {
        discardPartial = true
        throw new Error(
          `Could not download ${model.displayName}: the response exceeded the pinned file size.`,
        )
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
    if (hash.digest("hex") !== expectedSha256) {
      discardPartial = true
      throw new Error(`Could not download ${model.displayName}: SHA-256 verification failed.`)
    }
  } finally {
    await file.close().catch(() => undefined)
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
  const manifest = {
    version: GGUF_MANIFEST_VERSION,
    model: model.id,
    revision: model.ggufRevision,
    sha256: expectedSha256,
    size: pinnedFile.size,
  }
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

function normalizedSha256(value: string) {
  const digest = value.toLowerCase().replace(/^sha256:/, "")
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Expected a valid SHA-256 digest.")
  return digest
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
        const lock = { pid: process.pid, startedAt: new Date().toISOString() }
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8")
      } catch (error) {
        await rm(path, { force: true })
        throw error
      } finally {
        await handle.close().catch(() => undefined)
      }
      const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(path, now, now).catch(() => undefined)
      }, DOWNLOAD_LOCK_HEARTBEAT_MS)
      heartbeat.unref?.()
      return async () => {
        clearInterval(heartbeat)
        await rm(path, { force: true })
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await isStaleLock(path)) {
        await rm(path, { force: true })
        continue
      }
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }, DOWNLOAD_LOCK_POLL_MS)
        signal?.addEventListener("abort", abort, { once: true })
      })
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
      // A lock still being written has no JSON yet; only an old one is abandoned.
      return Date.now() - (await stat(path)).mtimeMs > 5_000
    }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return true
    // The holder refreshes the mtime while alive; a stale one is abandoned even when its pid
    // has been reused by an unrelated process since a reboot.
    if (Date.now() - (await stat(path)).mtimeMs > DOWNLOAD_LOCK_STALE_MS) return true
    try {
      process.kill(Number(value.pid), 0)
      return false
    } catch (error) {
      return errorCode(error) !== "EPERM"
    }
  } catch (error) {
    if (isNotFound(error)) return true
    throw error
  }
}

function isNotFound(error: unknown) {
  return errorCode(error) === "ENOENT"
}

function isAlreadyExists(error: unknown) {
  return errorCode(error) === "EEXIST"
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}
