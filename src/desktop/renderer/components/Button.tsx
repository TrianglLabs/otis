import type { LucideIcon } from "lucide-react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { Icon } from "./Icon"

type ButtonVariant = "primary" | "outline" | "ghost" | "danger"

export function Button({
  variant = "outline",
  size = "md",
  icon,
  iconAfter,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: "sm" | "md"
  icon?: LucideIcon
  /** Trailing icon, after the label (Send, Continue…). */
  iconAfter?: LucideIcon
  children?: ReactNode
}) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className ?? ""}`} {...rest}>
      {icon ? <Icon icon={icon} size={size === "sm" ? 12 : 14} /> : null}
      {children}
      {iconAfter ? <Icon icon={iconAfter} size={size === "sm" ? 12 : 14} /> : null}
    </button>
  )
}

export function IconButton({
  icon,
  label,
  size = 26,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: number }) {
  return (
    <button
      type="button"
      className={`iconBtn ${className ?? ""}`}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon icon={icon} size={14} />
    </button>
  )
}
