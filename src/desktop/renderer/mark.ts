/**
 * The Otis mark as data: the single source of truth for the renderer's OtisMark component and the
 * tray icon generator (scripts/tray-icon-render.ts). Coordinates live in the mark's 120×136
 * viewBox; every face is a 3×3 grid of 16×16 cells, and the front face drops its center cell to
 * draw the O.
 */

export const MARK_VIEWBOX = { width: 120, height: 136 } as const

export const MARK_CELL = 16

type Cell = readonly [x: number, y: number]

export type MarkFace = {
  /** SVG matrix(a b c d e f) mapping the 60×60 face grid into the mark's viewBox. */
  matrix: readonly [number, number, number, number, number, number]
  /** The face's fill opacity; the renderer lets CSS override the top face's value. */
  opacity: number
  cells: readonly Cell[]
}

/** The full nine-cell grid in row order; the O face uses it with the center cell removed. */
export const MARK_GRID: readonly Cell[] = [2, 22, 42].flatMap((y) =>
  [2, 22, 42].map((x): Cell => [x, y]),
)

export const MARK_FACES: Record<"top" | "left" | "front", MarkFace> = {
  top: { matrix: [0.866025, 0.5, -0.866025, 0.5, 60, 8], opacity: 0.7, cells: MARK_GRID },
  left: { matrix: [0.866025, 0.5, 0, 1, 8.0385, 38], opacity: 0.45, cells: MARK_GRID },
  front: {
    matrix: [0.866025, -0.5, 0, 1, 60, 68],
    opacity: 1,
    cells: MARK_GRID.filter(([x, y]) => x !== 22 || y !== 22),
  },
}
