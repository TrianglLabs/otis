/** Fireworks Fast serving paths use a router ID, not `service_tier`. */

import type { FireworksModel, HostedModel } from "./types.js"

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

export function matchesHostedModel(model: HostedModel, modelId: string) {
  return model.id === modelId || model.fastId === modelId
}

export function findHostedModel<T extends HostedModel>(models: readonly T[], modelId: string) {
  return models.find((model) => matchesHostedModel(model, modelId))
}

/**
 * Fast serving is opt-in. Keep an already-Fast model ID; otherwise require an explicit
 * preference.
 */
export function useFastServingPath(modelId: string | undefined, fast?: boolean) {
  return Boolean(modelId && isFastFireworksModel(modelId)) || fast === true
}

export function fireworksServingModel<T extends HostedModel>(model: T, fast: boolean): T {
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

export function selectDefaultFireworksModel<T extends HostedModel>(
  models: readonly T[],
): T | undefined {
  for (const modelId of DEFAULT_FIREWORKS_MODEL_IDS) {
    const model = models.find((candidate) => candidate.id === modelId)
    if (model) return model
  }
  return models.find((model) => !isFastFireworksModel(model.id)) ?? models[0]
}
