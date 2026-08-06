import type { LocalStats } from "../../local/stats.js"

const BUSY_WAVE_MIN_WIDTH = 16
const BUSY_WAVE_CHARS = ["·", "╴", "─", "━", "◆"]

export const CHAT_INPUT_HINT = " [TAB] mode · [ESC] interrupt "

export type AgentPhase = "thinking" | "working"

// Only phases listed here get a label overlaid on the wave; the rest show the wave alone.
export const AGENT_PHASE_LABELS: Partial<Record<AgentPhase, string>> = {
  thinking: "THINKING",
}

export function formatContextLabel(label: string) {
  return ` ${label} `
}

export function formatRuntimeHint(model: string, workspace: string) {
  return ` ${model || "No model selected"} · ${workspace} `
}

export function formatStats(stats: LocalStats) {
  return [
    { value: String(stats.streak), label: "day streak" },
    { value: formatTokenCount(stats.totalTokens), label: "all-time tokens" },
    { value: formatTokenCount(Math.round(stats.avgTokensPerSession)), label: "tokens/session" },
    { value: formatDuration(stats.avgSessionSeconds), label: "time/session" },
  ]
}

export function renderBusyStatus(frame: number, width: number, label?: string) {
  // Layout width can be NaN on the first frame before yoga measures the bar;
  // fall back to a wave the bar will truncate once it has a real width.
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : BUSY_WAVE_MIN_WIDTH
  const wave = renderBusyWave(frame, safeWidth).slice(0, safeWidth)
  const content = label ? embedCenteredLabel(wave, label) : wave
  return content.length > safeWidth ? content.slice(0, safeWidth) : content.padEnd(safeWidth)
}

function embedCenteredLabel(wave: string, label: string) {
  const text = ` ${label} `
  if (text.length >= wave.length) return text
  const start = Math.floor((wave.length - text.length) / 2)
  return `${wave.slice(0, start)}${text}${wave.slice(start + text.length)}`
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

function renderBusyWave(frame: number, width: number) {
  const safeWidth = Math.max(BUSY_WAVE_MIN_WIDTH, Math.floor(width))
  const cells: string[] = []
  const phase = frame * 0.32

  for (let index = 0; index < safeWidth; index += 1) {
    const primary = Math.sin(index * 0.32 - phase)
    const secondary = Math.sin(index * 0.11 + phase * 1.7)
    const carrier = Math.sin(index * 0.73 - phase * 2.4)
    const intensity = Math.max(0, (primary + secondary * 0.55 + carrier * 0.22 + 1.35) / 2.7)
    const level = Math.min(BUSY_WAVE_CHARS.length - 1, Math.floor(intensity * BUSY_WAVE_CHARS.length))
    cells.push(BUSY_WAVE_CHARS[level])
  }

  return cells.join("")
}
