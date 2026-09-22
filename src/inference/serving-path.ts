/** Fireworks Fast serving paths use a router ID, not `service_tier`. */

import type { FireworksModel } from "./types.js"

export function isFastFireworksModel(modelId: string) {
  return /\/routers\/[^/]+-fast$/i.test(normalizedModelResource(modelId))
}

function baseModelIdForFastServingPath(fastId: string) {
  const resource = normalizedModelResource(fastId)
  if (!isFastFireworksModel(resource)) return undefined
  const name = resource.slice(resource.lastIndexOf("/") + 1, -"-fast".length)
  return `accounts/fireworks/models/${name}`
}

export function baseFireworksModelId(modelId: string) {
  const resource = normalizedModelResource(modelId)
  return baseModelIdForFastServingPath(resource) ?? resource
}

export function fireworksServiceTier(modelId: string) {
  return isFastFireworksModel(modelId) ? undefined : "priority"
}

export function matchesFireworksModel(model: FireworksModel, modelId: string) {
  return model.id === modelId || model.fastId === modelId
}

export function findFireworksModel(models: readonly FireworksModel[], modelId: string) {
  return models.find((model) => matchesFireworksModel(model, modelId))
}

/**
 * Fast serving is opt-in. Keep an already-Fast model ID; otherwise require an explicit
 * preference.
 */
export function useFastServingPath(modelId: string | undefined, fast?: boolean) {
  return Boolean(modelId && isFastFireworksModel(modelId)) || fast === true
}

export function fireworksServingModel(model: FireworksModel, fast: boolean): FireworksModel {
  if (!model.fastId) return model
  return {
    ...model,
    id: fast ? model.fastId : (baseModelIdForFastServingPath(model.fastId) ?? model.id),
  }
}

export function withFastServingPaths(
  models: readonly FireworksModel[],
  fastIds: readonly string[],
) {
  const fastByBaseId = new Map<string, string>()
  for (const fastId of fastIds) {
    const baseId = baseModelIdForFastServingPath(fastId)
    if (baseId) fastByBaseId.set(baseId, fastId)
  }
  return models.map((model) => {
    const fastId = fastByBaseId.get(model.id)
    return fastId ? { ...model, fastId } : model
  })
}

function normalizedModelResource(modelId: string) {
  return modelId.trim().split("#", 1)[0] ?? ""
}

const DEFAULT_FIREWORKS_MODEL_IDS = [
  "accounts/fireworks/models/muse-glimmer-30b",
  "accounts/fireworks/models/inkling",
] as const

export function selectDefaultFireworksModel(
  models: readonly FireworksModel[],
): FireworksModel | undefined {
  for (const modelId of DEFAULT_FIREWORKS_MODEL_IDS) {
    const model = models.find((candidate) => candidate.id === modelId)
    if (model) return model
  }
  return models.find((model) => !isFastFireworksModel(model.id)) ?? models[0]
}
