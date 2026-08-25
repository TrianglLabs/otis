import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { llamaModelCacheDirectory } from "../local/paths.js"
import { LOCAL_MODELS, type LocalModelSpec } from "./local-catalog.js"

export function localGgufPath(model: LocalModelSpec, dataDirectory?: string) {
  const root = dataDirectory ? join(dataDirectory, "models") : llamaModelCacheDirectory()
  return join(root, model.ggufFile)
}

export function huggingFaceGgufUrl(model: LocalModelSpec) {
  return `https://huggingface.co/${model.ggufRepo}/resolve/main/${model.ggufFile}`
}

export async function isLocalGgufDownloaded(model: LocalModelSpec, dataDirectory?: string) {
  try {
    const info = await stat(localGgufPath(model, dataDirectory))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export async function listDownloadedLocalModels(dataDirectory?: string) {
  const downloaded = await Promise.all(
    LOCAL_MODELS.map(async (model) => ((await isLocalGgufDownloaded(model, dataDirectory)) ? model : undefined)),
  )
  return downloaded.filter((model): model is LocalModelSpec => model !== undefined)
}

export async function deleteLocalGguf(model: LocalModelSpec, dataDirectory?: string) {
  await rm(localGgufPath(model, dataDirectory), { force: true })
}

export type DownloadGgufOptions = {
  dataDirectory?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

export async function ensureLocalGguf(model: LocalModelSpec, options: DownloadGgufOptions = {}) {
  const dest = localGgufPath(model, options.dataDirectory)
  if (await isLocalGgufDownloaded(model, options.dataDirectory)) return dest

  options.signal?.throwIfAborted()
  const fetchImpl = options.fetch ?? fetch
  const headers: Record<string, string> = { "user-agent": "otis" }
  const token = huggingFaceToken(options.env ?? process.env)
  if (token) headers.authorization = `Bearer ${token}`

  const response = await fetchImpl(huggingFaceGgufUrl(model), {
    headers,
    signal: options.signal,
    redirect: "follow",
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${model.displayName} (HTTP ${response.status}).`)
  }

  const contentLength = Number(response.headers.get("content-length"))
  const expectedBytes = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : undefined
  const total = expectedBytes ?? model.weightBytes
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
  const partial = `${dest}.${process.pid}.${randomUUID()}.partial`
  const file = await open(partial, "wx", 0o600)
  let received = 0
  let lastPercent = -1
  let closed = false
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      options.signal?.throwIfAborted()
      if (!value || value.byteLength === 0) continue
      await file.write(value)
      received += value.byteLength
      const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
      if (percent !== lastPercent) {
        lastPercent = percent
        options.onProgress?.(percent)
      }
    }
    if (received === 0) throw new Error(`Could not download ${model.displayName}: the response was empty.`)
    if (expectedBytes !== undefined && received !== expectedBytes) {
      throw new Error(
        `Could not download ${model.displayName}: expected ${expectedBytes} bytes but received ${received}.`,
      )
    }
    await file.close()
    closed = true
    try {
      await rename(partial, dest)
    } catch (error) {
      // A concurrent downloader may have published the same model first on
      // platforms that do not replace an existing destination during rename.
      if (!(await isLocalGgufDownloaded(model, options.dataDirectory))) throw error
    }
  } finally {
    if (!closed) await file.close().catch(() => undefined)
    await rm(partial, { force: true })
  }
  if (lastPercent !== 100) options.onProgress?.(100)
  return dest
}

function huggingFaceToken(env: NodeJS.ProcessEnv) {
  return env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim() || undefined
}
