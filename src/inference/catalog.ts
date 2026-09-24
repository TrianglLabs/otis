import { inferenceResponseError, isRecord } from "./errors.js"
import { inferenceEndpointURL } from "./openai-compat.js"
import { isFastFireworksModel, withFastServingPaths } from "./serving-path.js"
import { type FireworksModel, fireworksModel } from "./types.js"

const DEFAULT_INFERENCE_MODELS_URL = "https://api.fireworks.ai/inference/v1/models"
const DEFAULT_MODELS_URL = "https://api.fireworks.ai/v1/accounts/fireworks/models"
const TOOL_CAPABLE_SERVERLESS_FILTER = "supports_serverless=true AND supports_tools=true"
const MAX_MODEL_PAGES = 20

type ListModelsOptions = {
  fetch?: typeof fetch
  modelsURL?: string
  inferenceModelsURL?: string
  signal?: AbortSignal
}

export async function listToolCapableModels(apiKey: string, options: ListModelsOptions = {}) {
  const key = apiKey.trim()
  if (!key) throw new Error("Fireworks API key is required.")
  const fetchImpl = options.fetch ?? fetch
  const init = { headers: { authorization: `Bearer ${key}` }, signal: options.signal }
  const modelsURL = inferenceEndpointURL(
    options.modelsURL ?? DEFAULT_MODELS_URL,
    "Fireworks models URL",
  )
  const inferenceURL = inferenceEndpointURL(
    options.inferenceModelsURL ?? DEFAULT_INFERENCE_MODELS_URL,
    "Fireworks inference models URL",
  )

  const listServerless = async () => {
    const models: FireworksModel[] = []
    const seenNames = new Set<string>()
    const seenPageTokens = new Set<string>()
    let pageToken: string | undefined
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const url = new URL(modelsURL)
      url.searchParams.set("pageSize", "200")
      url.searchParams.set("filter", TOOL_CAPABLE_SERVERLESS_FILTER)
      if (pageToken) url.searchParams.set("pageToken", pageToken)
      const response = await fetchImpl(url, init)
      if (!response.ok) throw await inferenceResponseError(response, "Fireworks")
      const body: unknown = await response.json()
      if (!isRecord(body) || !Array.isArray(body.models))
        throw new Error("Fireworks models response was invalid.")
      for (const value of body.models) {
        if (!isRecord(value) || value.supportsServerless !== true || value.supportsTools !== true)
          continue
        const name = nonEmptyString(value.name)
        if (!name || seenNames.has(name)) continue
        seenNames.add(name)
        const contextLength = value.contextLength
        models.push(
          fireworksModel({
            id: name,
            displayName: nonEmptyString(value.displayName) || name.split("/").at(-1) || name,
            ...(typeof contextLength === "number" &&
            Number.isInteger(contextLength) &&
            contextLength > 0
              ? { contextLength }
              : {}),
            supportsImageInput: value.supportsImageInput === true,
          }),
        )
      }
      pageToken = nonEmptyString(body.nextPageToken)
      if (!pageToken) break
      if (seenPageTokens.has(pageToken))
        throw new Error("Fireworks model pagination returned a repeated page token.")
      seenPageTokens.add(pageToken)
    }
    if (pageToken) throw new Error(`Fireworks model catalog exceeded ${MAX_MODEL_PAGES} pages.`)
    return models
  }

  // Fast is an additive serving path. Keep the verified serverless catalog if this list is
  // unavailable.
  const listFastIds = async () => {
    try {
      const response = await fetchImpl(inferenceURL, init)
      if (!response.ok) return []
      const body: unknown = await response.json()
      if (!isRecord(body) || !Array.isArray(body.data)) return []
      const ids: string[] = []
      for (const item of body.data) {
        if (!isRecord(item) || item.supports_tools !== true) continue
        const id = nonEmptyString(item.id)
        if (id && isFastFireworksModel(id)) ids.push(id)
      }
      return ids
    } catch {
      return []
    }
  }

  const [models, fastIds] = await Promise.all([listServerless(), listFastIds()])
  return withFastServingPaths(models, fastIds).sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
  )
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
