import { type LucideIcon, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import type { DataRetention } from "../../../inference/types.js"
import { useI18n } from "../i18n/index.js"

/**
 * Lucide icons with round line caps and joins, matching Otis's soft geometry.
 * Icons are decorative; adjacent text carries the accessible name.
 */
export function Icon({
  icon: IconComponent,
  size = 14,
  strokeWidth = 1.5,
  className,
}: {
  icon: LucideIcon
  size?: number
  strokeWidth?: number
  className?: string
}) {
  return (
    <IconComponent
      size={size}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    />
  )
}

const RETENTION_ICON: Record<DataRetention, LucideIcon> = {
  zero: ShieldCheck,
  optIn: ShieldAlert,
  unknown: ShieldQuestion,
}

/** A provider's documented data retention as a shield and a few words. */
export function RetentionBadge({ retention }: { retention: DataRetention }) {
  const { t } = useI18n()
  return (
    <span className={`retention retention-${retention}`}>
      <Icon icon={RETENTION_ICON[retention]} size={12} />
      {t(`privacy.${retention}`)}
    </span>
  )
}
