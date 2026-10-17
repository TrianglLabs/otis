/** A thin determinate bar: the track in the hairline tint, the accent fill at `percent`. */
export function ProgressBar({
  percent,
  label,
  className,
}: {
  percent: number
  label: string
  className?: string
}) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={className ? `progressBar ${className}` : "progressBar"}
    >
      <span className="progressBar-fill" style={{ width: `${percent}%` }} />
    </span>
  )
}

/**
 * The stop control of a load in progress, ringed by its progress, as the App Store draws a
 * download. A phase that cannot measure itself spins a short arc instead.
 */
export function ProgressStop({
  percent,
  label,
  className,
  onClick,
}: {
  percent?: number
  label: string
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={className ? `progressStop ${className}` : "progressStop"}
      aria-label={label}
      title={percent === undefined ? label : `${label} · ${percent}%`}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 22 22"
        aria-hidden="true"
        className={percent === undefined ? "progressStop-ring indeterminate" : "progressStop-ring"}
      >
        <circle cx="11" cy="11" r="7" className="progressStop-track" />
        <circle
          cx="11"
          cy="11"
          r="7"
          pathLength={1}
          className="progressStop-arc"
          style={percent === undefined ? undefined : { strokeDashoffset: 1 - percent / 100 }}
        />
      </svg>
      <span className="progressStop-square" />
    </button>
  )
}
