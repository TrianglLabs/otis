import type { FireworksModel } from "./types.js"

export const DEFAULT_FIREWORKS_MODEL_IDS = [
  "accounts/fireworks/models/muse-glimmer-30b",
  "accounts/fireworks/models/inkling",
] as const

export function selectDefaultFireworksModel(models: readonly FireworksModel[]): FireworksModel | undefined {
  for (const modelId of DEFAULT_FIREWORKS_MODEL_IDS) {
    const model = models.find((candidate) => candidate.id === modelId)
    if (model) return model
  }
  return models[0]
}
