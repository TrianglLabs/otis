import { type LucideIcon, Server, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import type { DataRetention, HostedProvider, LocalServerTab } from "../../../inference/types.js"
import baseten from "../assets/baseten.svg"
import fireworks from "../assets/fireworks.svg"
import lmStudio from "../assets/lm-studio.svg"
import ollama from "../assets/ollama.svg"
import omlx from "../assets/omlx.svg"
import primeIntellect from "../assets/prime-intellect.svg"
import river from "../assets/river.svg"
import together from "../assets/together.svg"
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

const PROVIDER_MARKS: Record<HostedProvider | Exclude<LocalServerTab, "custom">, string> = {
  fireworks,
  together,
  baseten,
  primeintellect: primeIntellect,
  river,
  ollama,
  lmStudio,
  omlx,
}

/**
 * A provider's logo as a rounded tile, sized by its class; a custom server has none, so the server
 * icon stands in. Decorative, like the icons.
 */
export function ProviderMark({
  provider,
  className,
}: {
  provider: HostedProvider | LocalServerTab
  className: string
}) {
  if (provider === "custom") return <Icon icon={Server} size={16} className={className} />
  return <img className={className} src={PROVIDER_MARKS[provider]} alt="" />
}
