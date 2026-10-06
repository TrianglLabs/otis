/** Display formatting helpers shared across renderer features. */

import type { GlobalSessionPickerItem } from "../../app/global-sessions.js"
import type { UsageTotals } from "../../inference/types.js"
import type { Translate } from "./i18n/messages/en.js"

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

/** Mirrors formatMemoryLabel in src/inference/local-fit.ts, for the same reason. */
export function formatMemory(bytes: number): string {
  const gib = bytes / 1024 ** 3
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1).replace(/\.0$/, "")} GB`
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

/**
 * A wall-clock span in whole units: `1s`, `34s`, `2m 5s`, `1h 12m`. Sub-second rounds up to `1s`.
 * Duplicates src/cli/ui/format.ts to keep the CLI module out of the renderer bundle.
 */
export function formatElapsed(durationMs: number): string {
  const total = Math.max(1, Math.round(durationMs / 1_000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export type UsageRow = {
  id: "uncached" | "cached" | "unknown" | "output"
  label: string
  tokens: number
}

/**
 * Input split into uncached and cached where the server reported a cache count, plain input
 * where it did not, then output. The hit rate covers the reported part only, and is absent
 * without one.
 */
export function usageBreakdown(usage: UsageTotals, t: Translate, locale: string) {
  const { promptTokens, completionTokens, cachedPromptTokens, cacheReportedPromptTokens } = usage
  const unknown = promptTokens - cacheReportedPromptTokens
  const rows: UsageRow[] = []
  if (cacheReportedPromptTokens > 0) {
    rows.push(
      {
        id: "uncached",
        label: t("settings.usageUncachedInput"),
        tokens: cacheReportedPromptTokens - cachedPromptTokens,
      },
      { id: "cached", label: t("settings.usageCachedInput"), tokens: cachedPromptTokens },
    )
  }
  if (unknown > 0 || cacheReportedPromptTokens === 0) {
    const key =
      cacheReportedPromptTokens > 0 ? "settings.usageInputNoCacheData" : "settings.usageInput"
    rows.push({ id: "unknown", label: t(key), tokens: unknown })
  }
  rows.push({ id: "output", label: t("settings.usageOutput"), tokens: completionTokens })
  const hitRate =
    cacheReportedPromptTokens > 0
      ? t("settings.usageCacheHit", {
          percent: new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(cachedPromptTokens / cacheReportedPromptTokens),
        })
      : null
  return { hitRate, rows }
}
