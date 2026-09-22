import type { LocalStats } from "../../local/stats.js"
import type { PermissionMode } from "../../permissions/policy.js"
import { colors } from "../theme.js"

/** Keyboard hints, shown briefly when the chat input hint is clicked. */
export const CHAT_KEY_HINT = " [TAB] mode · [ESC] interrupt "
export const CHAT_KEY_HINT_DURATION_MS = 3000
export const FAST_MODE_LABEL = "Fast mode"
export const RECOMMENDED_MODEL_MARK = "*"
/** Some layers run on the CPU; shown after a local model name. */
export const CPU_OFFLOAD_MODEL_MARK = "◐"

export type AgentPhase = "thinking" | "working"

// Only phases listed here get a label overlaid on the wave; the rest show the wave alone.
export const AGENT_PHASE_LABELS: Partial<Record<AgentPhase, string>> = {
  thinking: "THINKING",
}

export function formatContextLabel(label: string) {
  return ` ${label} `
}

/** A short wall-clock span for cards and panels, e.g. `850ms`, `3.2s`, `34s`. */
export function formatElapsed(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs}ms`
  const seconds = durationMs / 1_000
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
}

export function formatStats(stats: LocalStats) {
  return [
    { value: String(stats.streak), label: "day streak" },
    { value: formatTokenCount(stats.totalTokens), label: "all-time tokens" },
    { value: formatTokenCount(Math.round(stats.avgTokensPerSession)), label: "tokens/session" },
    { value: formatDuration(stats.avgSessionSeconds), label: "time/session" },
  ]
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function formatDuration(seconds: number) {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}H`
  if (seconds >= 60) return `${Math.round(seconds / 60)}M`
  return `${Math.round(seconds)}S`
}

export function formatModeLabel(mode: PermissionMode) {
  if (mode === "ask") return "? ask"
  if (mode === "auto") return "› auto"
  return "× dontAsk"
}

export function formatModelName(model: string | undefined) {
  return model ? model.slice(model.lastIndexOf("/") + 1) : ""
}

export function withFastModelMark(name: string, fast: boolean) {
  if (!name || !fast) return name
  return `${name} Fast`
}

type ContextUsage = {
  usedTokens: number
  contextWindowTokens: number
  percent: number
}

export function contextUsage(usedTokens: number, contextWindowTokens: number): ContextUsage {
  const percent = contextWindowTokens > 0 ? (usedTokens / contextWindowTokens) * 100 : 0
  return { usedTokens, contextWindowTokens, percent: Math.min(100, Math.max(0, percent)) }
}

const TRACK = 10
const FILL = "━"
const EMPTY = "─"

/**
 * A ten-cell meter, a percentage, and the rounded token count, e.g.
 * `━━━━━───── 50% · ~50k`.
 */
export function formatContextUsage({ percent, usedTokens }: ContextUsage) {
  const value = Math.min(100, Math.max(0, percent))
  const filled =
    value <= 0 ? 0 : value >= 100 ? TRACK : Math.max(1, Math.round((value / 100) * TRACK))
  const label = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`
  const tokens =
    usedTokens < 1_000
      ? String(usedTokens)
      : usedTokens < 1_000_000
        ? `${Math.round(usedTokens / 100) / 10}k`
        : `${Math.round(usedTokens / 100_000) / 10}M`
  return `${FILL.repeat(filled)}${EMPTY.repeat(TRACK - filled)} ${label} · ~${tokens}`
}

export function contextUsageColor(percent: number) {
  if (percent >= 90) return colors.pink
  if (percent >= 70) return colors.yellow
  return colors.muted
}
