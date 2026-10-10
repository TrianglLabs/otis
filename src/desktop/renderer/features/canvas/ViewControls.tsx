import { Minus, Plus } from "lucide-react"
import type { ReactNode } from "react"
import { IconButton } from "../../components/Button.js"
import { useI18n } from "../../i18n/index.js"

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const ZOOM_STEP = 1.2

/**
 * A view's zoom as one pill floating over its foot, the same for every Canvas view: out, the
 * level, which resets on a click, in, and whatever else the view offers after them. The view
 * owns the zoom; the pill only asks for a step or the reset.
 */
export function ViewControls({
  label,
  zoom,
  onZoom,
  onReset,
  children,
}: {
  label: string
  zoom: number
  /** Multiply the zoom by this factor, within the limits. */
  onZoom: (factor: number) => void
  onReset: () => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="viewControls" role="toolbar" aria-label={label}>
      <IconButton
        icon={Minus}
        label={t("canvas.zoomOut")}
        size={24}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onZoom(1 / ZOOM_STEP)}
      />
      <button
        type="button"
        className="viewControls-level"
        aria-label={t("canvas.resetView")}
        title={t("canvas.resetView")}
        onClick={onReset}
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        icon={Plus}
        label={t("canvas.zoomIn")}
        size={24}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onZoom(ZOOM_STEP)}
      />
      {children}
    </div>
  )
}
