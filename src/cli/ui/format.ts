import type { LocalStats } from "../../local/stats.js"
import type { PermissionMode } from "../../permissions/policy.js"

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

export function formatModeLabel(mode: PermissionMode) {
  if (mode === "ask") return "? ask"
  if (mode === "auto") return "› auto"
  return "× dontAsk"
}

export function formatModelName(model: string | undefined) {
  if (!model) return ""
  return model.includes("/") ? (model.split("/").at(-1) ?? model) : model
}

export function imageAttachmentLabel(count: number) {
  if (count <= 0) return ""
  const visible = Math.min(count, 2)
  const labels = Array.from({ length: visible }, (_, index) => `[Image ${index + 1}]`)
  if (count > visible) labels.push(`+${count - visible}`)
  return labels.join(" ")
}
