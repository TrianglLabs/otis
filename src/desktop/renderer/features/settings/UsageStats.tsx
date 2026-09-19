import { type CSSProperties, useState } from "react"
import type { LocalStats } from "../../../../local/stats.js"
import { formatTokenCount } from "../../format.js"
import { useI18n } from "../../i18n/index.js"

export function UsageStats({ stats }: { stats: LocalStats | undefined }) {
  const { locale, t } = useI18n()
  const [activeDate, setActiveDate] = useState<string>()

  if (!stats) {
    return (
      <div className="settingsGroup">
        <div className="settings-section">{t("settings.usage")}</div>
        <section className="settingsCard settingsUsage settingsUsage-loading" aria-busy="true">
          {t("settings.usageLoading")}
        </section>
      </div>
    )
  }

  const recentActivity = stats.recentActivity
  const maxDailyTokens = Math.max(1, ...recentActivity.map((day) => day.tokens))
  const number = new Intl.NumberFormat(locale)
  const firstDay = recentActivity[0]
  const lastDay = recentActivity.at(-1)
  const activeDay = recentActivity.find((day) => day.date === activeDate)
  const { promptTokens, completionTokens } = stats
  const countedTokens = promptTokens + completionTokens
  const inputShare = countedTokens === 0 ? 0 : (promptTokens / countedTokens) * 100

  return (
    <div className="settingsGroup">
      <div className="settings-section">{t("settings.usage")}</div>
      <section className="settingsCard settingsUsage" aria-label={t("settings.usage")}>
        <div className="settingsUsage-hero">
          <div className="settingsUsage-total">
            <span className="settingsUsage-eyebrow">{t("settings.usageTotal")}</span>
            <strong title={number.format(stats.totalTokens)}>{formatTokenCount(stats.totalTokens)}</strong>
            <span className="settingsUsage-note">{t("settings.usagePrivate")}</span>
          </div>
          <div className="settingsUsage-mix">
            <span className="settingsUsage-mixTitle">{t("settings.usageTokenMix")}</span>
            <div
              className="settingsUsage-mixTrack"
              data-empty={countedTokens === 0 ? "true" : undefined}
              style={{ "--usage-input-share": `${inputShare}%` } as CSSProperties}
              aria-hidden="true"
            >
              <span className="settingsUsage-mixInput" />
              <span className="settingsUsage-mixOutput" />
            </div>
            <div className="settingsUsage-mixValues">
              <span>
                <i className="settingsUsage-mixDot settingsUsage-mixDotInput" />
                {t("settings.usageInput")}
                <strong>{formatTokenCount(promptTokens)}</strong>
              </span>
              <span>
                <i className="settingsUsage-mixDot settingsUsage-mixDotOutput" />
                {t("settings.usageOutput")}
                <strong>{formatTokenCount(completionTokens)}</strong>
              </span>
            </div>
          </div>
        </div>

        <div className="settingsUsage-metrics">
          <UsageMetric label={t("settings.usageSessions")} value={number.format(stats.sessionCount)} />
          <UsageMetric label={t("settings.usageActiveDays")} value={number.format(stats.activeDays)} />
          <UsageMetric label={t("settings.usageStreak")} value={number.format(stats.streak)} />
        </div>

        <div className="settingsUsage-activity">
          <div className="settingsUsage-activityHeader">
            <span>{t("settings.usageRecent")}</span>
            {activeDay ? (
              <span className="settingsUsage-activeDay">
                {t("settings.usageDay", {
                  date: formatLongDate(activeDay.date, locale),
                  tokens: number.format(activeDay.tokens),
                })}
              </span>
            ) : firstDay && lastDay ? (
              <span>
                {formatShortDate(firstDay.date, locale)}–{formatShortDate(lastDay.date, locale)}
              </span>
            ) : null}
          </div>
          <div className="settingsUsage-chart">
            {recentActivity.map((day) => {
              const percent = Math.round((day.tokens / maxDailyTokens) * 100)
              const label = t("settings.usageDay", {
                date: formatLongDate(day.date, locale),
                tokens: number.format(day.tokens),
              })
              return (
                <button
                  type="button"
                  key={day.date}
                  className="settingsUsage-barSlot"
                  data-empty={day.tokens === 0 ? "true" : undefined}
                  style={{ "--usage-level": `${percent}%` } as CSSProperties}
                  aria-label={label}
                  onPointerEnter={() => setActiveDate(day.date)}
                  onPointerLeave={() => setActiveDate(undefined)}
                  onFocus={() => setActiveDate(day.date)}
                  onBlur={() => setActiveDate(undefined)}
                >
                  <span className="settingsUsage-bar" />
                </button>
              )
            })}
          </div>
          <div className="settingsUsage-average">
            <span>
              {t("settings.usageAverageTokens", {
                tokens: formatTokenCount(Math.round(stats.avgTokensPerSession)),
              })}
            </span>
            <span>{t("settings.usageAverageTime", { duration: formatActiveTime(stats.avgSessionSeconds) })}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="settingsUsage-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function formatShortDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(localDate(date))
}

function formatLongDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric" }).format(localDate(date))
}

function localDate(date: string) {
  return new Date(`${date}T12:00:00`)
}

function formatActiveTime(seconds: number) {
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds)}s`
}
