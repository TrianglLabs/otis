import { colors } from "./theme.js"

const METER_BLOCKS = 8

export function contextUsage(usedTokens: number, contextWindowTokens: number) {
  const percent = contextWindowTokens > 0 ? (usedTokens / contextWindowTokens) * 100 : 0
  return {
    usedTokens,
    contextWindowTokens,
    percent: Math.min(100, Math.max(0, percent)),
  }
}

export function formatContextUsage(usage: ReturnType<typeof contextUsage>) {
  return `${contextMeter(usage.percent)} ${formatPercent(usage.percent)} · ~${formatTokenCount(usage.usedTokens)}`
}

export function contextUsageColor(percent: number) {
  if (percent >= 90) return colors.pink
  if (percent >= 70) return colors.yellow
  return colors.muted
}

function contextMeter(percent: number) {
  const filled = Math.min(METER_BLOCKS, Math.max(0, Math.floor((percent / 100) * METER_BLOCKS)))
  return `${"■".repeat(filled)}${"□".repeat(METER_BLOCKS - filled)}`
}

function formatPercent(percent: number) {
  if (percent > 0 && percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

function formatTokenCount(tokens: number) {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`
  return `${Math.round(tokens / 100_000) / 10}M`
}
