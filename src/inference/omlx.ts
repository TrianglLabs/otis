import { normalizeLocalBaseURL } from "./local-endpoint.js"
import { OpenAICompatibleClient } from "./openai-compatible-client.js"
import type { OmlxCatalogModel } from "./types.js"

export const OMLX_DEFAULT_ENDPOINT = "http://127.0.0.1:8000"

export type OmlxSettings = { baseURL: string; apiKey?: string }
export type OmlxDiscoveryOptions = { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }

export function normalizeOmlxSettings(settings: OmlxSettings): OmlxSettings {
  const apiKey = settings.apiKey?.trim()
  return { baseURL: normalizeLocalBaseURL(settings.baseURL), ...(apiKey ? { apiKey } : {}) }
}

export class OmlxClient extends OpenAICompatibleClient {
  constructor(config: OmlxSettings & { model: string; fetch?: typeof fetch }) {
    super({
      ...config,
      inferenceURL: `${normalizeLocalBaseURL(config.baseURL)}/v1/chat/completions`,
      modelLabel: "oMLX model",
      inferenceURLLabel: "oMLX inference URL",
      requestLabel: "oMLX",
    })
  }
}

/** Inventory only: never loads a model or sends a preflight inference request. */
export async function discoverOmlxModels(
  settings: OmlxSettings,
  options: OmlxDiscoveryOptions = {},
): Promise<OmlxCatalogModel[]> {
  const { baseURL, apiKey } = normalizeOmlxSettings(settings)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers: Record<string, string> = { accept: "application/json" }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const get = async (path: string) => {
    const response = await (options.fetch ?? fetch)(`${baseURL}${path}`, { headers, signal, redirect: "error" })
    // Do not echo server response bodies: an authentication failure could reflect the key.
    if (!response.ok) throw new Error(`oMLX returned HTTP ${response.status}. Check the endpoint and API key.`)
    return (await response.json()) as unknown
  }
  let inventory: unknown
  try {
    inventory = await get("/v1/models")
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof Error && error.message.startsWith("oMLX returned HTTP")) throw error
    throw new Error("Could not read oMLX models. Start oMLX and check its address.")
  }
  if (!isRecord(inventory) || !Array.isArray(inventory.data)) throw new Error("oMLX returned an invalid model list.")

  // Optional oMLX metadata identifies VLMs and non-chat models. /v1/models remains authoritative for
  // visible IDs (including aliases and profiles); status must never add hidden models to the picker.
  const metadata = new Map<string, Record<string, unknown>>()
  try {
    const status = await get("/v1/models/status")
    if (isRecord(status) && Array.isArray(status.models)) {
      for (const entry of status.models) {
        if (!isRecord(entry) || typeof entry.id !== "string") continue
        metadata.set(entry.id, entry)
        if (typeof entry.model_alias === "string" && entry.model_alias) metadata.set(entry.model_alias, entry)
      }
    }
  } catch {
    options.signal?.throwIfAborted()
  }

  const seen = new Set<string>()
  return inventory.data.flatMap((entry): OmlxCatalogModel[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) return []
    seen.add(entry.id)
    const detail = metadata.get(entry.id)
    const modelType = detail?.model_type
    if (typeof modelType === "string" && modelType !== "llm" && modelType !== "vlm") return []
    const contextLength = positiveInteger(entry.max_model_len) ?? positiveInteger(detail?.max_context_window)
    return [
      {
        provider: "omlx",
        id: entry.id,
        displayName: entry.id,
        baseURL,
        ...(contextLength ? { contextLength } : {}),
        supportsImageInput: modelType === "vlm",
      },
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
