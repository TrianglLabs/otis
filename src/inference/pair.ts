import { isLoopbackHostname, responsePreview } from "./openai-compat.js"
import { OpenAICompatibleClient } from "./openai-compatible-client.js"
import type { PairCatalogModel, PairEngine } from "./types.js"

export type PairEndpoints = {
  ollama?: string
  lmStudio?: string
}

export const PAIR_DEFAULT_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  lmStudio: "http://127.0.0.1:1234",
} as const

const PAIR_REQUEST_TIMEOUT_MS = 2_000

export type PairClientConfig = {
  model: string
  baseURL: string
  fetch?: typeof fetch
}

export type PairDiscoveryOptions = {
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

type PairDiscoveryError = {
  engine: PairEngine
  baseURL: string
  error: Error
}

export type PairDiscovery = {
  ollama?: PairCatalogModel[]
  lmStudio?: PairCatalogModel[]
  errors: PairDiscoveryError[]
}

export class PairClient extends OpenAICompatibleClient {
  constructor(config: PairClientConfig) {
    const baseURL = normalizePairBaseURL(config.baseURL)
    super({
      model: config.model,
      inferenceURL: pairEndpointURL(baseURL, "/v1/chat/completions"),
      fetch: config.fetch,
      modelLabel: "PAIR model",
      inferenceURLLabel: "PAIR inference URL",
      requestLabel: "NVIDIA PAIR",
    })
  }
}

export async function discoverPairModels(
  endpoints: PairEndpoints,
  options: PairDiscoveryOptions = {},
): Promise<PairDiscovery> {
  const normalized = normalizePairEndpoints(endpoints)
  const probes: Array<{
    engine: PairEngine
    baseURL: string
    load: () => Promise<PairCatalogModel[]>
  }> = []
  const ollamaBaseURL = normalized.ollama
  if (ollamaBaseURL) {
    probes.push({
      engine: "ollama",
      baseURL: ollamaBaseURL,
      load: () => loadOllamaModels(ollamaBaseURL, options),
    })
  }
  const lmStudioBaseURL = normalized.lmStudio
  if (lmStudioBaseURL) {
    probes.push({
      engine: "lmstudio",
      baseURL: lmStudioBaseURL,
      load: () => loadLMStudioModels(lmStudioBaseURL, options),
    })
  }

  const settled = await Promise.allSettled(probes.map((probe) => probe.load()))
  options.signal?.throwIfAborted()
  const discovery: PairDiscovery = { errors: [] }
  settled.forEach((result, index) => {
    const probe = probes[index]
    if (!probe) return
    if (result.status === "fulfilled") {
      if (probe.engine === "ollama") discovery.ollama = result.value
      else discovery.lmStudio = result.value
      return
    }
    discovery.errors.push({
      engine: probe.engine,
      baseURL: probe.baseURL,
      error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
    })
  })
  return discovery
}

export function normalizePairEndpoints(endpoints: PairEndpoints): PairEndpoints {
  const normalized: PairEndpoints = {
    ...(endpoints.ollama ? { ollama: normalizePairBaseURL(endpoints.ollama) } : {}),
    ...(endpoints.lmStudio ? { lmStudio: normalizePairBaseURL(endpoints.lmStudio) } : {}),
  }
  if (normalized.ollama && normalized.ollama === normalized.lmStudio) {
    throw new Error("Ollama and LM Studio endpoints must be different.")
  }
  return normalized
}

export function normalizePairBaseURL(value: string) {
  const input = value.trim()
  if (!input) throw new Error("PAIR endpoint is required.")
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error("PAIR endpoint is invalid.")
  }
  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("PAIR endpoint must use HTTP on 127.0.0.1, localhost, or ::1.")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("PAIR endpoint must not include credentials, query parameters, or a fragment.")
  }
  const path = parsed.pathname.replace(/\/+$/, "")
  if (path && path !== "/v1") {
    throw new Error("PAIR endpoint must be the base URL shown in PAIR's Endpoints window.")
  }
  parsed.pathname = "/"
  return parsed.toString().replace(/\/$/, "")
}

export function pairEndpointForEngine(endpoints: PairEndpoints, engine: PairEngine | undefined) {
  if (engine === "ollama") return endpoints.ollama
  if (engine === "lmstudio") return endpoints.lmStudio
  return undefined
}

export function pairEngineLabel(engine: PairEngine) {
  return engine === "ollama" ? "Ollama" : "LM Studio"
}

export function pairModelKey(model: Pick<PairCatalogModel, "engine" | "id">) {
  return `pair:${model.engine}:${model.id}`
}

async function loadOllamaModels(baseURL: string, options: PairDiscoveryOptions) {
  const body = await requirePairJSON(baseURL, "/api/tags", options)
  if (!isRecord(body) || (!Array.isArray(body.models) && body.models !== null)) {
    throw new Error(`NVIDIA PAIR at ${baseURL} returned an invalid Ollama model list.`)
  }
  return pairModelsFromOllama(baseURL, Array.isArray(body.models) ? body.models : [])
}

async function loadLMStudioModels(baseURL: string, options: PairDiscoveryOptions) {
  const body = await requirePairJSON(baseURL, "/v1/models", options)
  if (!isRecord(body) || (!Array.isArray(body.data) && body.data !== null)) {
    throw new Error(`NVIDIA PAIR at ${baseURL} returned an invalid LM Studio model list.`)
  }
  return pairModelsFromLMStudio(baseURL, Array.isArray(body.data) ? body.data : [])
}

function pairModelsFromOllama(baseURL: string, entries: unknown[]) {
  const seen = new Set<string>()
  return entries.flatMap((entry): PairCatalogModel[] => {
    if (!isRecord(entry)) return []
    const id = firstText(entry.model, entry.name)
    if (!id || seen.has(id)) return []
    const capabilities = stringSet(entry.capabilities)
    if (capabilities.size > 0 && !capabilities.has("completion")) return []
    seen.add(id)
    const details = isRecord(entry.details) ? entry.details : undefined
    const nativeContextLength = positiveInteger(details?.context_length)
    const quantization = firstText(details?.quantization_level)
    return [
      {
        provider: "pair",
        id,
        displayName: pairModelDisplayName(id),
        baseURL,
        engine: "ollama",
        ...(nativeContextLength ? { nativeContextLength } : {}),
        ...(quantization ? { quantization } : {}),
        supportsImageInput: capabilities.has("vision"),
      },
    ]
  })
}

function pairModelsFromLMStudio(baseURL: string, entries: unknown[]) {
  const seen = new Set<string>()
  return entries.flatMap((entry): PairCatalogModel[] => {
    if (!isRecord(entry)) return []
    const id = firstText(entry.id)
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [
      {
        provider: "pair",
        id,
        displayName: pairModelDisplayName(id),
        baseURL,
        engine: "lmstudio",
        supportsImageInput: false,
      },
    ]
  })
}

function pairEndpointURL(baseURL: string, path: string) {
  return new URL(path, `${baseURL}/`).toString()
}

function pairModelDisplayName(id: string) {
  const last = id.split("/").at(-1) ?? id
  return last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || id
}

async function requirePairJSON(baseURL: string, path: string, options: PairDiscoveryOptions) {
  let response: Response
  try {
    response = await pairFetch(baseURL, path, options)
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new Error(`Could not reach NVIDIA PAIR at ${baseURL}: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    throw new Error(`NVIDIA PAIR at ${baseURL} returned HTTP ${response.status}: ${await responsePreview(response)}`)
  }
  try {
    return (await response.json()) as unknown
  } catch (error) {
    throw new Error(`NVIDIA PAIR at ${baseURL} returned an invalid model list: ${errorMessage(error)}`)
  }
}

function pairFetch(baseURL: string, path: string, options: PairDiscoveryOptions) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PAIR_REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  return (options.fetch ?? fetch)(pairEndpointURL(baseURL, path), {
    headers: { accept: "application/json" },
    signal,
  })
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringSet(value: unknown) {
  return new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
