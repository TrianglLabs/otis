import { ChevronLeft, ChevronRight, LoaderCircle, type LucideIcon } from "lucide-react"
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react"
import { useI18n } from "../i18n/index.js"
import { Icon } from "./Icon"

type ButtonVariant = "primary" | "tinted" | "ghost" | "danger"

export function Button({
  variant = "tinted",
  size = "md",
  icon,
  iconAfter,
  busy = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: "sm" | "md" | "lg"
  icon?: LucideIcon
  /** Trailing icon, after the label (Send, Continue…). */
  iconAfter?: LucideIcon
  /** The button's own work is under way: a spinner takes the icon's place and it cannot be pressed. */
  busy?: boolean
  children?: ReactNode
}) {
  const leading = busy ? LoaderCircle : icon
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${className ?? ""}`}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      {leading ? (
        <Icon icon={leading} size={size === "sm" ? 12 : 14} className={busy ? "spin" : undefined} />
      ) : null}
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

/**
 * A list shown a page at a time: the page's slice, and the pager's props. The page stays in range
 * as the list shrinks under it.
 */
export function usePage<T>(items: readonly T[], size: number) {
  const [index, setIndex] = useState(0)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const page = Math.min(index, pages - 1)
  return {
    shown: items.slice(page * size, (page + 1) * size),
    pager: { page, pages, onPage: setIndex },
  }
}

/** A home list's page controls, the chevrons and "1 of 3", shown once there is a second page. */
export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number
  pages: number
  onPage: (page: number) => void
}) {
  const { t } = useI18n()
  if (pages <= 1) return null
  return (
    <span className="pager">
      <IconButton
        icon={ChevronLeft}
        label={t("home.previousPage")}
        size={22}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      />
      {t("home.page", { page: page + 1, pages })}
      <IconButton
        icon={ChevronRight}
        label={t("home.nextPage")}
        size={22}
        disabled={page === pages - 1}
        onClick={() => onPage(page + 1)}
      />
    </span>
  )
}

/** A pill switch, in keeping with the app's soft geometry. */
export function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? " toggle-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}
