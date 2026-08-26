/** Fireworks Fast serving paths use a router ID, not `service_tier`. */

import type { FireworksModel } from "./types.js"

export function isFastFireworksModel(modelId: string) {
  return /\/routers\/[^/]+-fast$/i.test(normalizedModelResource(modelId))
}

export function baseModelIdForFastServingPath(fastId: string) {
  const resource = normalizedModelResource(fastId)
  if (!isFastFireworksModel(resource)) return undefined
  const slug = resource.split("/").at(-1)
  if (!slug) return undefined
  return `accounts/fireworks/models/${slug.slice(0, -"-fast".length)}`
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

/** Fast serving is opt-in. Keep an already-Fast model ID; otherwise require an explicit preference. */
export function useFastServingPath(modelId: string | undefined, fastMode?: boolean) {
  return Boolean(modelId && isFastFireworksModel(modelId)) || fastMode === true
}

export function fireworksServingModel(model: FireworksModel, fast: boolean): FireworksModel {
  if (!model.fastId) return model
  return fast
    ? { ...model, id: model.fastId }
    : { ...model, id: baseModelIdForFastServingPath(model.fastId) ?? model.id }
}

export function withFastServingPaths(models: readonly FireworksModel[], fastIds: readonly string[]) {
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
