import { Fragment } from "react"
import {
  addUsage,
  emptyUsage,
  type TokenUsage,
  type UsageTotals,
} from "../../../inference/types.js"
import { formatTokenCount, usageBreakdown } from "../format.js"
import { useI18n } from "../i18n/index.js"

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * How full the session's context is, as a ring that closes on the point where the conversation
 * compacts, with the share beside it: quiet while there is room, amber as compaction nears.
 * Hover or keyboard focus opens the breakdown: tokens used and the compaction point, then the
 * last request and the session's usage when there are any.
 */
export function ContextRing({
  tokens,
  limit,
  usage,
  placement,
}: {
  tokens: number
  limit: number
  usage?: { last: TokenUsage | null; total: UsageTotals }
  /** Where the breakdown opens: above, from the composer; below, from a header. */
  placement: "above" | "below"
}) {
  const { t } = useI18n()
  const percent = Math.min(100, Math.round((tokens / Math.max(1, limit)) * 100))
  const level = percent >= 90 ? " contextRing-full" : percent >= 75 ? " contextRing-near" : ""
  return (
    <div className={`contextRing noDrag contextRing-${placement}${level}`}>
      <button
        type="button"
        className="contextRing-button"
        aria-label={t("header.contextShare", { percent: `${percent}%` })}
      >
        <svg className="contextRing-dial" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="contextRing-track" cx="8" cy="8" r={RADIUS} />
          <circle
            className="contextRing-fill"
            cx="8"
            cy="8"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
          />
        </svg>
        <span className="contextRing-value">{percent}%</span>
      </button>
      <div className="contextMeter-popover contextRing-popover">
        <p className="contextMeter-section">
          {t("header.context")}
          <span>{t("header.contextShare", { percent: `${percent}%` })}</span>
        </p>
        <dl className="contextMeter-rows">
          <dt>{t("header.contextUsed")}</dt>
          <dd>{formatTokenCount(tokens)}</dd>
          <dt>{t("header.contextAutoCompact")}</dt>
          <dd>{formatTokenCount(limit)}</dd>
        </dl>
        {usage?.last ? (
          <>
            <UsageRows title={t("header.lastRequest")} usage={addUsage(emptyUsage(), usage.last)} />
            <UsageRows title={t("header.thisSession")} usage={usage.total} />
          </>
        ) : null}
      </div>
    </div>
  )
}

function UsageRows({ title, usage }: { title: string; usage: UsageTotals }) {
  const { locale, t } = useI18n()
  const { hitRate, rows } = usageBreakdown(usage, t, locale)
  return (
    <>
      <p className="contextMeter-section">
        {title}
        {hitRate ? <span>{hitRate}</span> : null}
      </p>
      <dl className="contextMeter-rows">
        {rows.map((row) => (
          <Fragment key={row.id}>
            <dt>{row.label}</dt>
            <dd>{formatTokenCount(row.tokens)}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  )
}
