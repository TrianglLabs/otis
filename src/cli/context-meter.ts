import type { ContextUsage } from "../app/context-usage.js"
import { colors } from "./theme.js"

const TRACK = 10
const FILL = "━"
const EMPTY = "─"

export function formatContextUsage(usage: ContextUsage) {
  return `${contextMeter(usage.percent)} ${formatPercent(usage.percent)} · ~${formatTokenCount(usage.usedTokens)}`
}

export function contextUsageColor(percent: number) {
  if (percent >= 90) return colors.pink
  if (percent >= 70) return colors.yellow
  return colors.muted
}

function contextMeter(percent: number) {
  const value = Math.min(100, Math.max(0, percent))
  const filled = value <= 0 ? 0 : value >= 100 ? TRACK : Math.max(1, Math.round((value / 100) * TRACK))
  return `${FILL.repeat(filled)}${EMPTY.repeat(TRACK - filled)}`
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
