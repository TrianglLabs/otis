import { discoverOmlxModels, normalizeOmlxSettings, type OmlxSettings } from "../inference/omlx.js"
import {
  discoverPairModels,
  normalizePairEndpoints,
  type PairEndpoints,
} from "../inference/pair.js"
import type { OmlxCatalogModel, PairCatalogModel } from "../inference/types.js"

export type LocalServerInputs = {
  ollama?: string
  lmStudio?: string
  omlx?: string
  omlxApiKey?: string
}
export type LocalServerConnection = {
  pairEndpoints: PairEndpoints
  omlx?: OmlxSettings
  pairModels: PairCatalogModel[]
  omlxModels: OmlxCatalogModel[]
}
export type LocalServerDiscoveryOptions = {
  signal?: AbortSignal
  discoverPair?: typeof discoverPairModels
  discoverOmlx?: typeof discoverOmlxModels
}

/** Shared setup transaction input for terminal and desktop; discovery never runs inference. */
export async function prepareLocalServers(
  input: LocalServerInputs,
  previousOmlx: OmlxSettings | undefined,
  options: LocalServerDiscoveryOptions = {},
): Promise<LocalServerConnection> {
  const requested = normalizePairEndpoints({
    ollama: input.ollama?.trim(),
    lmStudio: input.lmStudio?.trim(),
  })
  const omlx = input.omlx?.trim() ? normalizeOmlxSettings({ baseURL: input.omlx }) : undefined
  if (omlx && (omlx.baseURL === requested.ollama || omlx.baseURL === requested.lmStudio)) {
    throw new Error("Enter the oMLX endpoint only in the oMLX field.")
  }
  const apiKey =
    input.omlxApiKey?.trim() ||
    (previousOmlx?.baseURL === omlx?.baseURL ? previousOmlx?.apiKey : undefined)
  if (omlx && apiKey) omlx.apiKey = apiKey
  if (!requested.ollama && !requested.lmStudio && !omlx) {
    throw new Error("Enter at least one local model server endpoint.")
  }
  const [pairResult, omlxResult] = await Promise.allSettled([
    (options.discoverPair ?? discoverPairModels)(requested, { signal: options.signal }),
    omlx
      ? (options.discoverOmlx ?? discoverOmlxModels)(omlx, { signal: options.signal })
      : Promise.resolve(undefined),
  ])
  options.signal?.throwIfAborted()
  const pair = pairResult.status === "fulfilled" ? pairResult.value : undefined
  const omlxModels = omlxResult.status === "fulfilled" ? omlxResult.value : undefined
  if (!pair?.ollama && !pair?.lmStudio && !omlxModels) {
    if (omlxResult.status === "rejected") throw omlxResult.reason
    throw new Error(
      "No compatible model server was found. Start your local model server and check its address.",
    )
  }
  const pairModels = [...(pair?.ollama ?? []), ...(pair?.lmStudio ?? [])]
  if (!pairModels.length && !omlxModels?.length) {
    throw new Error(
      "The connected model servers report no available models. Add or load a model and try again.",
    )
  }
  // An explicitly authenticated oMLX connection must never appear successful when its
  // credentials fail.
  if (omlx?.apiKey && omlxResult.status === "rejected") throw omlxResult.reason
  return {
    pairEndpoints: {
      ...(pair?.ollama !== undefined && requested.ollama ? { ollama: requested.ollama } : {}),
      ...(pair?.lmStudio !== undefined && requested.lmStudio
        ? { lmStudio: requested.lmStudio }
        : {}),
    },
    ...(omlxModels !== undefined ? { omlx } : {}),
    pairModels,
    omlxModels: omlxModels ?? [],
  }
}
