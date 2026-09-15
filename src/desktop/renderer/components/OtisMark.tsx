import { MARK_CELL, MARK_FACES, MARK_VIEWBOX, type MarkFace } from "../mark.js"

/** Shared cube artwork: muted faces and an O face in the current theme's accent. Geometry lives in mark.ts. */
export function OtisMark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
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
        <g key={group.key} transform={`matrix(${group.matrix.join(" ")})`} opacity={group.opacity} fill={group.fill}>
          {group.cells.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={MARK_CELL} height={MARK_CELL} rx={2} />
          ))}
        </g>
      ))}
    </svg>
  )
}

/**
 * Presentation-only overrides on the shared geometry: the theme may retune the top face's opacity, and the O
 * face carries the accent. Faces paint back to front exactly as the original artwork did.
 */
type FaceGroup = {
  key: string
  matrix: MarkFace["matrix"]
  cells: MarkFace["cells"]
  /** Defaults to the shared opacity; the top face defers to a CSS variable. */
  opacity?: string | number
  /** The front face carries the accent fill. */
  fill?: string
}

const FACE_GROUPS: FaceGroup[] = [
  {
    key: "top",
    matrix: MARK_FACES.top.matrix,
    cells: MARK_FACES.top.cells,
    opacity: "var(--otis-mark-top-opacity, .7)",
  },
  { key: "left", matrix: MARK_FACES.left.matrix, cells: MARK_FACES.left.cells, opacity: MARK_FACES.left.opacity },
  {
    key: "front",
    matrix: MARK_FACES.front.matrix,
    cells: MARK_FACES.front.cells,
    fill: "var(--accent, currentColor)",
  },
]
