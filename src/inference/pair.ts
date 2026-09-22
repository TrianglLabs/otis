import { errorMessage, isRecord, positiveInteger } from "./errors.js"
import { OllamaClient } from "./ollama-client.js"
import { normalizeLocalBaseURL, OpenAICompatibleClient } from "./openai-compat.js"
import type { PairCatalogModel, PairEngine } from "./types.js"

export type PairEndpoints = {
  ollama?: string
  lmStudio?: string
}

export const PAIR_DEFAULT_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  lmStudio: "http://127.0.0.1:1234",
} as const

type PairClientConfig = {
  model: string
  baseURL: string
  fetch?: typeof fetch
  idleTimeoutMs?: number
}

type PairDiscoveryOptions = {
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export type PairDiscovery = {
  ollama?: PairCatalogModel[]
  lmStudio?: PairCatalogModel[]
  errors: Array<{ engine: PairEngine; baseURL: string; error: Error }>
}

class PairClient extends OpenAICompatibleClient {
  constructor(config: PairClientConfig) {
    super({
      model: config.model,
      inferenceURL: `${normalizeLocalBaseURL(config.baseURL)}/v1/chat/completions`,
      fetch: config.fetch,
      idleTimeoutMs: config.idleTimeoutMs,
      modelLabel: "Local model-server model",
      inferenceURLLabel: "Local model-server inference URL",
      requestLabel: "Local model server",
    })
  }
}

export function createPairClient(config: PairClientConfig & { engine: PairEngine }) {
  return config.engine === "ollama" ? new OllamaClient(config) : new PairClient(config)
}

export async function discoverPairModels(
  endpoints: PairEndpoints,
  options: PairDiscoveryOptions = {},
): Promise<PairDiscovery> {
  const normalized = normalizePairEndpoints(endpoints)
  const probes = (["ollama", "lmstudio"] as const).flatMap((engine) => {
    const baseURL = pairEndpointForEngine(normalized, engine)
    return baseURL ? [{ engine, baseURL }] : []
  })
  const settled = await Promise.allSettled(
    probes.map((probe) => loadPairModels(probe.engine, probe.baseURL, options)),
  )
  options.signal?.throwIfAborted()
  const discovery: PairDiscovery = { errors: [] }
  probes.forEach(({ engine, baseURL }, index) => {
    const result = settled[index]
    if (result.status === "rejected") {
      const error =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason))
      discovery.errors.push({ engine, baseURL, error })
    } else if (engine === "ollama") discovery.ollama = result.value
    else discovery.lmStudio = result.value
  })
  return discovery
}

export function normalizePairEndpoints(endpoints: PairEndpoints): PairEndpoints {
  const normalized: PairEndpoints = {
    ...(endpoints.ollama ? { ollama: normalizeLocalBaseURL(endpoints.ollama) } : {}),
    ...(endpoints.lmStudio ? { lmStudio: normalizeLocalBaseURL(endpoints.lmStudio) } : {}),
  }
  if (normalized.ollama && normalized.ollama === normalized.lmStudio) {
    throw new Error("Ollama and LM Studio endpoints must be different.")
  }
  return normalized
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

async function loadPairModels(engine: PairEngine, baseURL: string, options: PairDiscoveryOptions) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(
      `${baseURL}${engine === "ollama" ? "/api/tags" : "/v1/models"}`,
      {
        headers: { accept: "application/json" },
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      },
    )
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new Error(`Could not reach a model server at ${baseURL}: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    const preview = await response.text().then(
      (text) => text.slice(0, 2000) || response.statusText,
      () => response.statusText,
    )
    throw new Error(`Model server at ${baseURL} returned HTTP ${response.status}: ${preview}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(
      `Model server at ${baseURL} returned an invalid model list: ${errorMessage(error)}`,
    )
  }
  const entries = isRecord(body) ? (engine === "ollama" ? body.models : body.data) : undefined
  if (!Array.isArray(entries) && entries !== null) {
    throw new Error(
      `Model server at ${baseURL} returned an invalid ${pairEngineLabel(engine)} model list.`,
    )
  }

  const seen = new Set<string>()
  const model = (id: string) => ({
    provider: "pair" as const,
    id,
    displayName: pairModelDisplayName(id),
    baseURL,
  })
  if (engine === "lmstudio") {
    return (entries ?? []).flatMap((entry): PairCatalogModel[] => {
      const id = isRecord(entry) ? firstText(entry.id) : undefined
      if (!id || seen.has(id)) return []
      seen.add(id)
      return [{ ...model(id), engine, supportsImageInput: false }]
    })
  }
  return (entries ?? []).flatMap((entry): PairCatalogModel[] => {
    if (!isRecord(entry)) return []
    const id = firstText(entry.model, entry.name)
    if (!id || seen.has(id)) return []
    const capabilities = new Set(
      (Array.isArray(entry.capabilities) ? entry.capabilities : []).filter(
        (item) => typeof item === "string",
      ),
    )
    if (capabilities.size > 0 && !capabilities.has("completion")) return []
    seen.add(id)
    const details = isRecord(entry.details) ? entry.details : undefined
    const nativeContextLength = positiveInteger(details?.context_length)
    const quantization = firstText(details?.quantization_level)
    return [
      {
        ...model(id),
        engine,
        ...(nativeContextLength ? { nativeContextLength } : {}),
        ...(quantization ? { quantization } : {}),
        supportsImageInput: capabilities.has("vision"),
      },
    ]
  })
}

function pairModelDisplayName(id: string) {
  const last = id.split("/").at(-1) ?? id
  return last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || id
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
