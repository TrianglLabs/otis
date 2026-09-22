/** Display formatting helpers shared across renderer features. */

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * Mirrors formatContextWindow from the inference picker catalog (uppercase K, exact divisions
 * only). Duplicated deliberately: the catalog module pulls Node-only dependencies that must stay
 * out of the renderer bundle.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens < 1_000) return String(tokens)
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
  return `${Math.round(tokens / 1_000)}K`
}

/**
 * Localizes the compact relative ages supplied by session metadata while preserving English's
 * established copy.
 */
export function formatSessionDetail(detail: string, locale: string): string {
  if (locale === "en") return detail
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  if (detail === "now" || detail === "Just now") return relative.format(0, "second")
  if (detail === "Yesterday") return relative.format(-1, "day")
  const match = /^(\d+)(m|h|d|w) ago$/.exec(detail)
  if (!match) return detail
  const count = Number(match[1])
  const unit =
    match[2] === "m" ? "minute" : match[2] === "h" ? "hour" : match[2] === "d" ? "day" : "week"
  return relative.format(-count, unit)
}
