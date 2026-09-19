/** Display formatting helpers shared across renderer features. */

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * Mirrors formatContextWindow from the inference picker catalog (uppercase K, exact divisions only). Duplicated
 * deliberately: the catalog module pulls Node-only dependencies that must stay out of the renderer bundle.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) {
    if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
    if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
    return `${Math.round(tokens / 1_000)}K`
  }
  return String(tokens)
}

/** `accounts/fireworks/models/kimi-k2p5-turbo` → `kimi-k2p5-turbo` */
/** Mirrors withFastModelMark in src/cli/ui/format.ts; the CLI module cannot be imported into the renderer bundle. */
export function shortModelId(id: string): string {
  const segments = id.split("/")
  return segments[segments.length - 1] ?? id
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Localizes the compact relative ages supplied by session metadata while preserving English's established copy. */
export function formatSessionDetail(detail: string, locale: string): string {
  if (locale === "en") return detail
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  if (detail === "now" || detail === "Just now") return relative.format(0, "second")
  if (detail === "Yesterday") return relative.format(-1, "day")
  const match = /^(\d+)(m|h|d|w) ago$/.exec(detail)
  if (!match) return detail
  const count = Number(match[1])
  const unit = match[2] === "m" ? "minute" : match[2] === "h" ? "hour" : match[2] === "d" ? "day" : "week"
  return relative.format(-count, unit)
}

export const PROVIDER_LABELS: Record<string, string> = {
  fireworks: "Fireworks",
  local: "Local",
  pair: "Local model server",
}
