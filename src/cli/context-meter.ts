import type { ContextUsage } from "../app/context-usage.js"
import { colors } from "./theme.js"

const TRACK = 10
const FILL = "━"
const TIP = "╸"
const START = "╺"
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
  if (value <= 0) return EMPTY.repeat(TRACK)
  if (value >= 100) return FILL.repeat(TRACK)

  const units = (value / 100) * TRACK
  const filled = Math.min(TRACK - 1, Math.floor(units))
  const fraction = units - filled
  const head = fraction >= 0.5 ? TIP : filled === 0 ? START : ""
  const body = `${FILL.repeat(filled)}${head}`
  return `${body}${EMPTY.repeat(TRACK - body.length)}`
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
