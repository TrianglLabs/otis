export type ContextUsage = {
  usedTokens: number
  contextWindowTokens: number
  percent: number
}

export function contextUsage(usedTokens: number, contextWindowTokens: number): ContextUsage {
  const percent = contextWindowTokens > 0 ? (usedTokens / contextWindowTokens) * 100 : 0
  return {
    usedTokens,
    contextWindowTokens,
    percent: Math.min(100, Math.max(0, percent)),
  }
}
