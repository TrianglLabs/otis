/** Fireworks Fast serving paths use a router ID, not `service_tier`. */
export function isFastFireworksModel(modelId: string) {
  return /\/routers\/[^/]+-fast$/i.test(modelId.trim().split("#", 1)[0] ?? "")
}

export function fireworksServiceTier(modelId: string) {
  return isFastFireworksModel(modelId) ? undefined : "priority"
}
