import type { LucideIcon } from "lucide-react"

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
