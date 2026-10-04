import {
  discoverPairModels,
  normalizePairEndpoints,
  type PairEndpoints,
} from "../inference/pair.js"
import { discoverServerModels, normalizeServerSettings } from "../inference/servers.js"
import {
  type PairCatalogModel,
  SERVER_INFO,
  SERVER_PROVIDERS,
  type ServerCatalogModel,
  type ServerProvider,
  type ServerSettings,
} from "../inference/types.js"

/** A server as a form submits it; a blank address means the server is not configured. */
export type ServerInput = {
  baseURL: string
  apiKey?: string
  model?: string
  contextLength?: string
}
export type LocalServerInputs = { ollama?: string; lmStudio?: string } & Partial<
  Record<ServerProvider, ServerInput>
>
export type LocalServerConnection = {
  pairEndpoints: PairEndpoints
  servers: Partial<Record<ServerProvider, ServerSettings>>
  pairModels: PairCatalogModel[]
  serverModels: Partial<Record<ServerProvider, ServerCatalogModel[]>>
}
export type LocalServerDiscoveryOptions = {
  signal?: AbortSignal
  discoverPair?: typeof discoverPairModels
  discoverServer?: typeof discoverServerModels
}

/** Shared setup transaction input for terminal and desktop; discovery never runs inference. */
export async function prepareLocalServers(
  input: LocalServerInputs,
  previous: Partial<Record<ServerProvider, ServerSettings>>,
  options: LocalServerDiscoveryOptions = {},
): Promise<LocalServerConnection> {
  const requested = normalizePairEndpoints({
    ollama: input.ollama?.trim(),
    lmStudio: input.lmStudio?.trim(),
  })
  const entries: [ServerProvider, ServerSettings][] = []
  for (const provider of SERVER_PROVIDERS) {
    const entered = input[provider]
    if (!entered?.baseURL.trim()) continue
    const limit = entered.contextLength?.trim()
    if (limit && !/^\d+$/.test(limit))
      throw new Error(`Enter the ${SERVER_INFO[provider].name} context limit in tokens.`)
    const server = normalizeServerSettings({
      baseURL: entered.baseURL,
      apiKey: entered.apiKey,
      model: entered.model,
      contextLength: limit ? Number(limit) : undefined,
    })
    if (server.baseURL === requested.ollama || server.baseURL === requested.lmStudio)
      throw new Error(`Enter the ${SERVER_INFO[provider].name} endpoint only in its own field.`)
    // A blank key keeps the saved one for the same address.
    const saved = previous[provider]
    if (!server.apiKey && saved?.baseURL === server.baseURL && saved.apiKey)
      server.apiKey = saved.apiKey
    entries.push([provider, server])
  }
  if (!requested.ollama && !requested.lmStudio && !entries.length)
    throw new Error("Enter at least one local model server endpoint.")
  const discover = options.discoverServer ?? discoverServerModels
  const [pair, ...probed] = await Promise.all([
    (options.discoverPair ?? discoverPairModels)(requested, { signal: options.signal }).catch(
      () => undefined,
    ),
    ...entries.map(([provider, server]) =>
      discover(provider, server, { signal: options.signal }).then(
        (models) => ({ provider, server, models }),
        (error: unknown) => ({ provider, server, error }),
      ),
    ),
  ])
  options.signal?.throwIfAborted()
  const servers: Partial<Record<ServerProvider, ServerSettings>> = {}
  const serverModels: Partial<Record<ServerProvider, ServerCatalogModel[]>> = {}
  const failed: { server: ServerSettings; error: unknown }[] = []
  for (const probe of probed) {
    if (!("models" in probe)) {
      failed.push(probe)
      continue
    }
    servers[probe.provider] = probe.server
    serverModels[probe.provider] = probe.models
  }
  const pairModels = [...(pair?.ollama ?? []), ...(pair?.lmStudio ?? [])]
  if (!pair?.ollama && !pair?.lmStudio && !Object.keys(serverModels).length) {
    if (failed.length) throw failed[0].error
    throw new Error(
      "No compatible model server was found. Start your local model server and check its address.",
    )
  }
  if (!pairModels.length && !Object.values(serverModels).some((models) => models.length)) {
    throw new Error(
      "The connected model servers report no available models. Add or load a model and try again.",
    )
  }
  // An explicitly authenticated server must never appear connected when its credentials fail.
  const refused = failed.find((probe) => probe.server.apiKey)
  if (refused) throw refused.error
  return {
    pairEndpoints: {
      ...(pair?.ollama !== undefined && requested.ollama ? { ollama: requested.ollama } : {}),
      ...(pair?.lmStudio !== undefined && requested.lmStudio
        ? { lmStudio: requested.lmStudio }
        : {}),
    },
    servers,
    pairModels,
    serverModels,
  }
}
