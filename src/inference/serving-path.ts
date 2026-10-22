/** Fireworks Fast serving paths use a router ID, not `service_tier`. */

import type { HostedModel } from "./types.js"

export function isFastFireworksModel(modelId: string) {
  return /\/routers\/[^/]+-fast$/i.test(modelId.trim().split("#", 1)[0] ?? "")
}

export function fireworksServiceTier(modelId: string) {
  return isFastFireworksModel(modelId) ? undefined : "priority"
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
