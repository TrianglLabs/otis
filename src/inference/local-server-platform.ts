/** oMLX runs on macOS; only advertise its local setup there. Safe to import in UI adapters. */
export function supportsOmlx(platform: string | undefined): boolean {
  return platform === "darwin"
}

export function localServerNames(platform: string | undefined): string[] {
  return ["Ollama", "LM Studio", ...(supportsOmlx(platform) ? ["oMLX"] : [])]
}
