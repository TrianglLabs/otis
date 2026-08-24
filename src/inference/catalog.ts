import { isFastFireworksModel, withFastServingPaths } from "./serving-path.js"
import type { FireworksModel } from "./types.js"

const DEFAULT_INFERENCE_MODELS_URL = "https://api.fireworks.ai/inference/v1/models"
const DEFAULT_MODELS_URL = "https://api.fireworks.ai/v1/accounts/fireworks/models"
const TOOL_CAPABLE_SERVERLESS_FILTER = "supports_serverless=true AND supports_tools=true"
const MAX_MODEL_PAGES = 20

export async function listToolCapableModels(apiKey: string, options: ListModelsOptions = {}) {
  const key = required(apiKey, "Fireworks API key")
  const fetchImpl = options.fetch ?? fetch
  const [models, fastIds] = await Promise.all([
    listServerlessModels(key, fetchImpl, options),
    listFastServingPathIds(key, fetchImpl, options),
  ])
  return withFastServingPaths(models, fastIds).sort(
    (left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
  )
}

type ListModelsOptions = {
  fetch?: typeof fetch
  modelsURL?: string
  inferenceModelsURL?: string
  signal?: AbortSignal
}

async function listServerlessModels(apiKey: string, fetchImpl: typeof fetch, options: ListModelsOptions) {
  const endpoint = validHttpsURL(options.modelsURL ?? DEFAULT_MODELS_URL, "Fireworks models URL")
  const models: FireworksModel[] = []
  const seenNames = new Set<string>()
  const seenPageTokens = new Set<string>()
  let pageToken: string | undefined

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL(endpoint)
    url.searchParams.set("pageSize", "200")
    url.searchParams.set("filter", TOOL_CAPABLE_SERVERLESS_FILTER)
    if (pageToken) url.searchParams.set("pageToken", pageToken)

    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: options.signal })
    if (!response.ok) {
      throw new Error(`Could not load Fireworks models (HTTP ${response.status}): ${await responseText(response)}`)
    }

    const result = parseModelsResponse(await response.json())
    for (const model of result.models) {
      if (!model.supportsServerless || !model.supportsTools || seenNames.has(model.name)) continue
      seenNames.add(model.name)
      models.push(toFireworksModel(model))
    }

    pageToken = result.nextPageToken
    if (!pageToken) break
    if (seenPageTokens.has(pageToken)) throw new Error("Fireworks model pagination returned a repeated page token.")
    seenPageTokens.add(pageToken)
  }

  if (pageToken) throw new Error(`Fireworks model catalog exceeded ${MAX_MODEL_PAGES} pages.`)
  return models
}

async function listFastServingPathIds(apiKey: string, fetchImpl: typeof fetch, options: ListModelsOptions) {
  const endpoint = validHttpsURL(
    options.inferenceModelsURL ?? DEFAULT_INFERENCE_MODELS_URL,
    "Fireworks inference models URL",
  )
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: options.signal,
    })
    if (!response.ok) return []
    return parseFastServingPathIds(await response.json())
  } catch {
    // Fast is an additive serving path. Keep the verified serverless catalog if this list is unavailable.
    return []
  }
}

function parseModelsResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("Fireworks models response was invalid.")
  return {
    models: value.models.map(parseModel).filter((model): model is RawModel => model !== undefined),
    nextPageToken: nonEmptyString(value.nextPageToken),
  }
}

function parseFastServingPathIds(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  const ids: string[] = []
  for (const item of value.data) {
    if (!isRecord(item) || item.supports_tools !== true) continue
    const id = nonEmptyString(item.id)
    if (id && isFastFireworksModel(id)) ids.push(id)
  }
  return ids
}

type RawModel = {
  name: string
  displayName?: string
  contextLength?: number
  supportsServerless: boolean
  supportsTools: boolean
  supportsImageInput: boolean
}

function toFireworksModel(model: RawModel): FireworksModel {
  return {
    id: model.name,
    displayName: model.displayName || model.name.split("/").at(-1) || model.name,
    ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
    supportsImageInput: model.supportsImageInput,
  }
}

function parseModel(value: unknown): RawModel | undefined {
  if (!isRecord(value)) return undefined
  const name = nonEmptyString(value.name)
  if (!name) return undefined
  return {
    name,
    displayName: nonEmptyString(value.displayName),
    contextLength: positiveInteger(value.contextLength),
    supportsServerless: value.supportsServerless === true,
    supportsTools: value.supportsTools === true,
    supportsImageInput: value.supportsImageInput === true,
  }
}

function validHttpsURL(value: string, label: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is invalid.`)
  }
  const localHTTP = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  if (parsed.protocol !== "https:" && !localHTTP) throw new Error(`${label} must use HTTPS.`)
  return parsed.toString()
}

function required(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

async function responseText(response: Response) {
  try {
    return (await response.text()).slice(0, 2000) || response.statusText
  } catch {
    return response.statusText
  }
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
