/** Display formatting helpers shared across renderer features. */

import type { GlobalSessionPickerItem } from "../../app/global-sessions.js"

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * Mirrors formatContextWindow from the inference picker catalog: exact thousands for
 * provider-stated decimal windows, binary K for local and native windows, and a rounded binary K
 * marked `~` otherwise. Duplicated deliberately: the catalog module pulls Node-only dependencies that must
 * stay out of the renderer bundle.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens < 1_000) return String(tokens)
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
  return `~${Math.round(tokens / 1_024)}K`
}

/**
 * The compact age a session row carries, for rows the renderer stamps itself. Mirrors
 * formatSessionAge in src/app/sessions.ts, which stays out of the renderer bundle.
 */
export function formatAge(iso: string, locale: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  const detail =
    seconds < 60
      ? "now"
      : seconds < 3_600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86_400
          ? `${Math.floor(seconds / 3_600)}h ago`
          : `${Math.floor(seconds / 86_400)}d ago`
  return formatSessionDetail(detail, locale)
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

/** Whether opening `anchor` brings `session` back on screen beside it. */
export function inView(
  anchor: GlobalSessionPickerItem | undefined,
  session: GlobalSessionPickerItem,
) {
  return (
    anchor !== session &&
    anchor?.view?.members.some((m) => m.id === session.id && m.dirName === session.dirName)
  )
}
