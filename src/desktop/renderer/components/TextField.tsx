import type { LucideIcon } from "lucide-react"
import type { InputHTMLAttributes } from "react"
import { Icon } from "./Icon.js"

/**
 * The app's one text field: a bordered row, led by an icon when the field has a clear kind, with
 * the input inside. `className` lays out the row; everything else reaches the input.
 */
export function TextField({
  icon,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon }) {
  return (
    <span className={`field${className ? ` ${className}` : ""}`}>
      {icon ? <Icon icon={icon} className="field-icon" /> : null}
      <input className="field-input" {...input} />
    </span>
  )
}
