import { type LucideIcon, Server, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import type { ModelVendor, VendorId } from "../../../inference/picker-filter.js"
import type { DataRetention, HostedProvider, LocalServerTab } from "../../../inference/types.js"
import baseten from "../assets/baseten.svg"
import fireworks from "../assets/fireworks.svg"
import lmStudio from "../assets/lm-studio.svg"
import ollama from "../assets/ollama.svg"
import omlx from "../assets/omlx.svg"
import openrouter from "../assets/openrouter.svg"
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
  openrouter,
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

/**
 * Each vendor's logo, by the file name its vendor id gives it. A full-color SVG is an image, as is
 * a raster; one with parts the vendor draws in black or white (`currentColor`) is inline, so those
 * parts take the text color and read in both themes. Its title goes, since the mark is decorative
 * and the name sits beside it.
 */
const VENDOR_MARKS = Object.fromEntries([
  ...Object.entries(
    import.meta.glob<string>("../assets/vendors/*.svg", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, svg]) => [
    path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf(".")),
    svg.includes("currentColor")
      ? { inline: svg.replace(/<title>[^<]*<\/title>/, "") }
      : { src: `data:image/svg+xml,${encodeURIComponent(svg)}` },
  ]),
  ...Object.entries(
    import.meta.glob<string>("../assets/vendors/*.{png,webp}", { import: "default", eager: true }),
  ).map(([path, src]) => [path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf(".")), { src }]),
]) as Partial<Record<VendorId, { inline: string } | { src: string }>>

/**
 * A model's vendor logo in the vendor's own colors, sized like an icon; a vendor with no logo,
 * or a model of no known vendor, gets the initial of its name on a tile. Decorative, like the
 * icons.
 */
export function VendorMark({
  vendor,
  label,
  className,
}: {
  vendor?: ModelVendor
  /** What the tile spells when there is no logo: the vendor's name, else the model's. */
  label: string
  className?: string
}) {
  const mark = vendor?.id && VENDOR_MARKS[vendor.id]
  const name = `vendorMark${className ? ` ${className}` : ""}`
  if (!mark)
    return (
      <span className={`${name} vendorMark-letter`} aria-hidden>
        {(vendor?.name ?? label).trim().charAt(0).toUpperCase()}
      </span>
    )
  if ("src" in mark) return <img className={name} src={mark.src} alt="" />
  return (
    <span
      className={name}
      aria-hidden
      // A logo bundled with the app, never user or network content.
      dangerouslySetInnerHTML={{ __html: mark.inline }}
    />
  )
}
