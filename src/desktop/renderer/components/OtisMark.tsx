import { MARK_CELL, MARK_FACES, MARK_VIEWBOX, type MarkFace } from "../mark.js"

/**
 * Presentation-only overrides on the shared geometry: the theme may retune the top face's opacity,
 * and the O face carries the accent. Faces paint back to front exactly as the original artwork did.
 */
const FACE_GROUPS: (Omit<MarkFace, "opacity"> & {
  key: string
  opacity?: string | number
  fill?: string
})[] = [
  { key: "top", ...MARK_FACES.top, opacity: "var(--otis-mark-top-opacity, .7)" },
  { key: "left", ...MARK_FACES.left },
  { key: "front", ...MARK_FACES.front, opacity: undefined, fill: "var(--accent, currentColor)" },
]

/**
 * Shared cube artwork: muted faces and an O face in the current theme's accent. Geometry lives in
 * mark.ts.
 */
export function OtisMark({
  className,
  decorative = false,
}: {
  className?: string
  decorative?: boolean
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MARK_VIEWBOX.width} ${MARK_VIEWBOX.height}`}
      fill="currentColor"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Otis"}
      aria-hidden={decorative || undefined}
    >
      {decorative ? null : <title>Otis</title>}
      {FACE_GROUPS.map((group) => (
        <g
          key={group.key}
          transform={`matrix(${group.matrix.join(" ")})`}
          opacity={group.opacity}
          fill={group.fill}
        >
          {group.cells.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={MARK_CELL} height={MARK_CELL} rx={2} />
          ))}
        </g>
      ))}
    </svg>
  )
}
