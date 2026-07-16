import type { LocalStats } from "../../local/stats.js"

const THINKING_WAVE_MIN_WIDTH = 16
const THINKING_WAVE_CHARS = ["·", "╴", "─", "━", "◆"]

export const ESC_INTERRUPT_HINT = " [ESC] interrupt "

export function formatContextLabel(label: string) {
  return ` ${label} `
}

export function formatStats(stats: LocalStats) {
  return [
    { value: String(stats.streak), label: "day streak" },
    { value: formatTokenCount(stats.totalTokens), label: "all-time tokens" },
    { value: formatTokenCount(Math.round(stats.avgTokensPerSession)), label: "tokens/session" },
    { value: formatDuration(stats.avgSessionSeconds), label: "time/session" },
  ]
}

export function renderThinkingStatus(frame: number, width: number) {
  const safeWidth = Math.max(1, Math.floor(width))
  const content = renderThinkingSignal(frame, safeWidth)
  return content.length > safeWidth ? content.slice(0, safeWidth) : content.padEnd(safeWidth)
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function formatDuration(seconds: number) {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}H`
  if (seconds >= 60) return `${Math.round(seconds / 60)}M`
  return `${Math.round(seconds)}S`
}

function renderThinkingSignal(frame: number, width: number) {
  const safeWidth = Math.max(THINKING_WAVE_MIN_WIDTH, Math.floor(width))
  const cells: string[] = []
  const phase = frame * 0.32

  for (let index = 0; index < safeWidth; index += 1) {
    const primary = Math.sin(index * 0.32 - phase)
    const secondary = Math.sin(index * 0.11 + phase * 1.7)
    const carrier = Math.sin(index * 0.73 - phase * 2.4)
    const intensity = Math.max(0, (primary + secondary * 0.55 + carrier * 0.22 + 1.35) / 2.7)
    const level = Math.min(THINKING_WAVE_CHARS.length - 1, Math.floor(intensity * THINKING_WAVE_CHARS.length))
    cells.push(THINKING_WAVE_CHARS[level])
  }

  return cells.join("")
}
