import { inferenceResponseError, isRecord } from "./errors.js"
import { inferenceEndpointURL } from "./openai-compat.js"
import { isFastFireworksModel, withFastServingPaths } from "./serving-path.js"
import {
  type FireworksModel,
  HOSTED_PROVIDER_INFO,
  type HostedModel,
  type HostedProvider,
} from "./types.js"

const DEFAULT_FIREWORKS_INFERENCE_MODELS_URL = "https://api.fireworks.ai/inference/v1/models"
const TOOL_CAPABLE_SERVERLESS_FILTER = "supports_serverless=true AND supports_tools=true"
const MAX_MODEL_PAGES = 20

/**
 * Together's model list carries no tool-calling flag, so Otis offers the serverless chat models
 * its function-calling documentation names, and only while the live catalog still lists them.
 * Image input follows each model's documented modalities.
 */
const TOGETHER_TOOL_MODELS: Record<string, { supportsImageInput: boolean }> = {
  "thinkingmachines/Inkling": { supportsImageInput: true },
  "MiniMaxAI/MiniMax-M3": { supportsImageInput: true },
  "Qwen/Qwen3.5-9B": { supportsImageInput: true },
  "moonshotai/Kimi-K3": { supportsImageInput: true },
  "zai-org/GLM-5.3": { supportsImageInput: false },
  "zai-org/GLM-5.3-Flash": { supportsImageInput: true },
  "zai-org/GLM-5.2": { supportsImageInput: false },
  "openai/gpt-oss-120b": { supportsImageInput: false },
  "deepseek-ai/DeepSeek-V4-Flash-0731": { supportsImageInput: false },
  "deepseek-ai/DeepSeek-V4-Pro-0813": { supportsImageInput: false },
  "deepseek-ai/DeepSeek-V4.1-Flash": { supportsImageInput: true },
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": { supportsImageInput: false },
}

type ListModelsOptions = {
  fetch?: typeof fetch
  modelsURL?: string
  /** Fireworks' inference-side list, which names the Fast serving paths. */
  inferenceModelsURL?: string
  signal?: AbortSignal
}

/**
 * The tool-capable models a hosted provider serves to this key, sorted by name. Fireworks' catalog
 * states tool support per model, as do Prime Intellect's supported parameters; every Baseten
 * Model API supports tools; Together's documented function-calling models are kept where its
 * live list confirms them.
 */
export async function listHostedModels(
  provider: HostedProvider,
  apiKey: string,
  options: ListModelsOptions = {},
): Promise<HostedModel[]> {
  const info = HOSTED_PROVIDER_INFO[provider]
  const { name } = info
  const key = apiKey.trim()
  if (!key) throw new Error(`${name} API key is required.`)
  const fetchImpl = options.fetch ?? fetch
  const init = { headers: { authorization: `Bearer ${key}` }, signal: options.signal }
  const modelsURL = inferenceEndpointURL(options.modelsURL ?? info.modelsURL, `${name} models URL`)
  const byName = (left: HostedModel, right: HostedModel) =>
    left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
  const fetchJson = async (url: string | URL) => {
    const response = await fetchImpl(url, init)
    if (!response.ok) throw await inferenceResponseError(response, name)
    return (await response.json()) as unknown
  }

  if (provider !== "fireworks") {
    const body = await fetchJson(modelsURL)
    // Together answers with a bare array; the others with OpenAI's `{ data }` envelope.
    const rows = Array.isArray(body) ? body : isRecord(body) ? body.data : undefined
    if (!Array.isArray(rows)) throw new Error(`${name} models response was invalid.`)
    const models: HostedModel[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (!isRecord(row)) continue
      const id = nonEmptyString(row.id)
      if (!id || seen.has(id)) continue
      const curated = provider === "together" ? TOGETHER_TOOL_MODELS[id] : undefined
      if (provider === "together" && (!curated || row.type !== "chat")) continue
      const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : []
      if (provider === "primeintellect" && !parameters.includes("tools")) continue
      seen.add(id)
      const features = Array.isArray(row.supported_features) ? row.supported_features : []
      const specs = isRecord(row.specs) ? row.specs : {}
      const modalities = isRecord(specs.modalities) ? specs.modalities : {}
      const inputs = Array.isArray(modalities.input) ? modalities.input : []
      models.push({
        provider,
        id,
        displayName:
          nonEmptyString(row.display_name) ??
          nonEmptyString(row.name) ??
          id.split("/").at(-1) ??
          id,
        ...contextLengthField(row.context_length ?? row.context_window),
        supportsImageInput:
          curated?.supportsImageInput ?? (features.includes("vision") || inputs.includes("image")),
      })
    }
    return models.sort(byName)
  }

  const inferenceURL = inferenceEndpointURL(
    options.inferenceModelsURL ?? DEFAULT_FIREWORKS_INFERENCE_MODELS_URL,
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
      const body = await fetchJson(url)
      if (!isRecord(body) || !Array.isArray(body.models))
        throw new Error("Fireworks models response was invalid.")
      for (const value of body.models) {
        if (!isRecord(value) || value.supportsServerless !== true || value.supportsTools !== true)
          continue
        const id = nonEmptyString(value.name)
        if (!id || seenNames.has(id)) continue
        seenNames.add(id)
        models.push({
          provider: "fireworks",
          id,
          displayName: nonEmptyString(value.displayName) ?? id.split("/").at(-1) ?? id,
          ...contextLengthField(value.contextLength),
          supportsImageInput: value.supportsImageInput === true,
        })
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
  return withFastServingPaths(models, fastIds).sort(byName)
}

function contextLengthField(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? { contextLength: value }
    : {}
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
