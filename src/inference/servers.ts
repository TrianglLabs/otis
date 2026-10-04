import { isRecord, positiveInteger } from "./errors.js"
import { normalizeLocalBaseURL, OpenAICompatibleClient } from "./openai-compat.js"
import {
  SERVER_INFO,
  type ServerCatalogModel,
  type ServerProvider,
  type ServerSettings,
} from "./types.js"

type ServerDiscoveryOptions = {
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export function normalizeServerSettings(settings: ServerSettings): ServerSettings {
  const apiKey = settings.apiKey?.trim()
  const model = settings.model?.trim()
  return {
    baseURL: normalizeLocalBaseURL(settings.baseURL),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(settings.contextLength ? { contextLength: settings.contextLength } : {}),
  }
}

/** A user-managed OpenAI-compatible server's chat completions, with the key as a bearer header. */
export class ServerClient extends OpenAICompatibleClient {
  constructor(
    provider: ServerProvider,
    config: ServerSettings & { model: string; fetch?: typeof fetch },
  ) {
    const { name } = SERVER_INFO[provider]
    super({
      ...config,
      inferenceURL: `${normalizeLocalBaseURL(config.baseURL)}/v1/chat/completions`,
      modelLabel: `${name} model`,
      inferenceURLLabel: `${name} inference URL`,
      requestLabel: name,
    })
  }
}

/**
 * Inventory only: never loads a model or sends a preflight inference request. `/v1/models` names
 * the visible models; oMLX's `/v1/models/status` adds model type and vision. A server that lists
 * nothing serves the model named in its settings, and one that reports no context limit uses the
 * limit entered with it.
 */
export async function discoverServerModels(
  provider: ServerProvider,
  settings: ServerSettings,
  options: ServerDiscoveryOptions = {},
): Promise<ServerCatalogModel[]> {
  const { name } = SERVER_INFO[provider]
  const {
    baseURL,
    apiKey,
    model: configuredModel,
    contextLength: configuredLength,
  } = normalizeServerSettings(settings)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers = {
    accept: "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
  const get = async (path: string) => {
    const response = await (options.fetch ?? fetch)(`${baseURL}${path}`, {
      headers,
      signal,
      redirect: "error",
    })
    if (response.status === 404) return undefined
    // Do not echo server response bodies: an authentication failure could reflect the key.
    if (!response.ok)
      throw new Error(`${name} returned HTTP ${response.status}. Check the endpoint and API key.`)
    return (await response.json()) as unknown
  }
  let inventory: unknown
  try {
    inventory = await get("/v1/models")
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof Error && error.message.startsWith(`${name} returned HTTP`)) throw error
    throw new Error(`Could not read ${name} models. Start ${name} and check its address.`)
  }
  // A server without a model list still serves the model its settings name.
  if (inventory === undefined) {
    if (!configuredModel) throw new Error(`${name} lists no models. Enter the model id it serves.`)
    inventory = { data: [{ id: configuredModel }] }
  }
  if (!isRecord(inventory) || !Array.isArray(inventory.data))
    throw new Error(`${name} returned an invalid model list.`)

  // Optional oMLX metadata identifies VLMs and non-chat models. /v1/models remains
  // authoritative for visible IDs (including aliases and profiles); status must never add
  // hidden models to the picker.
  const status =
    provider === "omlx"
      ? await get("/v1/models/status").catch(() => {
          options.signal?.throwIfAborted()
          return undefined
        })
      : undefined
  const metadata = new Map<string, Record<string, unknown>>()
  for (const entry of isRecord(status) && Array.isArray(status.models) ? status.models : []) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue
    metadata.set(entry.id, entry)
    if (typeof entry.model_alias === "string" && entry.model_alias)
      metadata.set(entry.model_alias, entry)
  }

  const seen = new Set<string>()
  return inventory.data.flatMap((entry): ServerCatalogModel[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id))
      return []
    seen.add(entry.id)
    const detail = metadata.get(entry.id)
    const modelType = detail?.model_type
    if (typeof modelType === "string" && modelType !== "llm" && modelType !== "vlm") return []
    const contextLength =
      positiveInteger(entry.max_model_len) ??
      positiveInteger(entry.context_length) ??
      positiveInteger(detail?.max_context_window) ??
      configuredLength
    return [
      {
        provider,
        id: entry.id,
        displayName: entry.id,
        baseURL,
        ...(contextLength ? { contextLength } : {}),
        supportsImageInput: modelType === "vlm",
      },
    ]
  })
}
