import type { LucideIcon } from "lucide-react"

/**
 * Lucide icons with square line caps and miter joins, matching Otis's straight-angled geometry.
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
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={className}
      aria-hidden
    />
  )
}
