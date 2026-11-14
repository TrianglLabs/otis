import { useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n/index.js"
import { MARK_CELL, MARK_FACES, MARK_GRID, MARK_VIEWBOX } from "../mark.js"

type Vec = [number, number, number]

/**
 * A sticker of the 3×3 cube the mark draws: the cubie it sits on (-1, 0 or 1 along each axis from
 * the cube's center), the way it faces, and whether it belongs to the accent face.
 */
type Sticker = { key: string; at: Vec; facing: Vec; accent: boolean }

/** A quarter turn of the outer layer on one side (-1 or 1) of an axis, in a direction (-1 or 1). */
type Move = { axis: number; side: number; direction: number }

type Pose = { stickers: Sticker[]; turning?: { move: Move; angle: number } }

const UNIT: Vec[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const PITCH = MARK_GRID[1][0] - MARK_GRID[0][0]

/**
 * The cube in the mark's pose: +x faces right as the accent face, its center left out for the O;
 * +y is the top face and +z the left one. Turns never move a face's center, so the O stays put.
 */
const SOLVED = [-1, 1]
  .flatMap((sign) =>
    [0, 1, 2].flatMap((axis) =>
      [-1, 0, 1].flatMap((i) =>
        [-1, 0, 1].map((j): Sticker => {
          const facing = UNIT[axis].map((unit) => unit * sign) as Vec
          const at = facing.map((c, k) => c || (k === (axis + 1) % 3 ? i : j)) as Vec
          return { key: `${at}/${facing}`, at, facing, accent: sign === 1 && axis === 0 }
        }),
      ),
    ),
  )
  .filter(({ accent, at }) => !accent || at[1] !== 0 || at[2] !== 0)

// The mark's isometric projection, read back from its top face: x and z run along that face's
// axes, up is straight up the page, and the cube's center is the view box's.
const [XX, XY, ZX, ZY] = MARK_FACES.top.matrix
const { width, height } = MARK_VIEWBOX
const VIEW_BOX = `${-width / 2} ${-height / 2} ${width} ${height}`
// Lit as the mark's faces are: the right one fully, the top by the theme's opacity, the left
// dimmest, and a turning sticker in between.
const LIT = {
  top: `var(--otis-mark-top-opacity, ${MARK_FACES.top.opacity})`,
  left: MARK_FACES.left.opacity,
}

/** `v` turned right-handedly by `angle` about `axis`. */
function turn(v: Vec, axis: number, angle: number): Vec {
  const [b, c] = [(axis + 1) % 3, (axis + 2) % 3]
  const turned: Vec = [...v]
  turned[b] = v[b] * Math.cos(angle) - v[c] * Math.sin(angle)
  turned[c] = v[b] * Math.sin(angle) + v[c] * Math.cos(angle)
  return turned
}

// An odd count always shows: it permutes the corners oddly, and only one corner is out of sight.
const SCRAMBLE_TURNS = 9
/**
 * Milliseconds per scrambling turn, for the scrambled beat, per solving turn, and for a looping
 * cube's rest between solves.
 */
const TIMING = { scramble: 95, hold: 260, solve: 150, rest: 500 }

/**
 * Plays random scrambles undone turn by turn on `frame`: every move is a real one, so the solve is
 * real with no solver. Once, or looping with a rest at the solved cube until the frame is
 * cancelled; nothing with reduced motion or while already playing.
 */
function play(frame: { current: number }, setPose: (pose: Pose) => void, loop: boolean) {
  if (frame.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const cycle = (): { ms: number; move?: Move }[] => {
    // No two turns in a row share an axis, so none undoes or doubles the one before it.
    let axis = Math.floor(Math.random() * 3)
    const scramble = Array.from({ length: SCRAMBLE_TURNS }, (): Move => {
      axis = (axis + 1 + Math.floor(Math.random() * 2)) % 3
      return { axis, side: Math.random() < 0.5 ? -1 : 1, direction: Math.random() < 0.5 ? -1 : 1 }
    })
    return [
      ...scramble.map((move) => ({ ms: TIMING.scramble, move })),
      { ms: TIMING.hold },
      ...scramble
        .toReversed()
        .map((move) => ({ ms: TIMING.solve, move: { ...move, direction: -move.direction } })),
      ...(loop ? [{ ms: TIMING.rest }] : []),
    ]
  }
  let steps = cycle()
  let current = SOLVED
  let start: number | undefined
  let step = 0
  const tick = (now: number) => {
    start ??= now
    // Commits every step whose time is up, several when a frame comes late.
    while (now - start >= steps[step].ms) {
      const { ms, move } = steps[step]
      start += ms
      if (move) {
        const quarter = (v: Vec) =>
          turn(v, move.axis, (move.direction * Math.PI) / 2).map(Math.round) as Vec
        current = current.map((sticker) =>
          sticker.at[move.axis] === move.side
            ? { ...sticker, at: quarter(sticker.at), facing: quarter(sticker.facing) }
            : sticker,
        )
      }
      step += 1
      if (step < steps.length) continue
      if (!loop) {
        frame.current = 0
        setPose({ stickers: current })
        return
      }
      steps = cycle()
      step = 0
    }
    const { ms, move } = steps[step]
    // A quarter turn eased by a sine, which starts and settles gently without a cubic's rush.
    const angle = (Math.PI / 4) * (1 - Math.cos((Math.PI * (now - start)) / ms))
    setPose({
      stickers: current,
      ...(move && { turning: { move, angle: move.direction * angle } }),
    })
    frame.current = requestAnimationFrame(tick)
  }
  frame.current = requestAnimationFrame(tick)
}

/**
 * The cube artwork: muted faces and an O face in the current theme's accent, drawn as stickers on
 * a 3×3 cube seen from (1, 1, 1). A solvable mark is a button that scrambles the cube and solves
 * it; a looping one does so on its own, again and again.
 */
export function OtisMark({
  className,
  decorative = false,
  solvable = false,
  looping = false,
}: {
  className?: string
  decorative?: boolean
  solvable?: boolean
  looping?: boolean
}) {
  const { t } = useI18n()
  const [{ stickers, turning }, setPose] = useState<Pose>({ stickers: SOLVED })
  const frame = useRef(0)
  useEffect(() => {
    if (looping) play(frame, setPose, true)
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [looping])

  const moving = (sticker: Sticker) =>
    turning !== undefined && sticker.at[turning.move.axis] === turning.move.side
  // The turning layer and the rest are each convex, so painting them whole, the one nearer the
  // viewer last, needs no sorting within either.
  const painted = turning
    ? stickers.toSorted((a, b) => (Number(moving(a)) - Number(moving(b))) * turning.move.side)
    : stickers
  const hidden = decorative || solvable
  const mark = (
    <svg
      className={className}
      viewBox={VIEW_BOX}
      fill="currentColor"
      // A turning layer's corners reach a little past the cube's outline.
      overflow="visible"
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : "Otis"}
      aria-hidden={hidden || undefined}
    >
      {hidden ? null : <title>Otis</title>}
      {painted.map((sticker) => {
        const { at, facing } = sticker
        const place = (v: Vec) =>
          turning && moving(sticker) ? turn(v, turning.move.axis, turning.angle) : v
        const [right, up, left] = place(facing)
        if (right + up + left <= 0) return null
        const axis = facing.findIndex(Boolean)
        const center = at.map((c, k) => c * PITCH + (facing[k] * PITCH) / 2) as Vec
        const [[ux, uy], [vx, vy], [cx, cy]] = [
          UNIT[(axis + 1) % 3],
          UNIT[(axis + 2) % 3],
          center,
        ].map((v) => {
          const [x, y, z] = place(v)
          return [XX * x + ZX * z, XY * x + ZY * z - y]
        })
        return (
          <rect
            key={sticker.key}
            x={-MARK_CELL / 2}
            y={-MARK_CELL / 2}
            width={MARK_CELL}
            height={MARK_CELL}
            rx={2}
            transform={`matrix(${ux} ${uy} ${vx} ${vy} ${cx} ${cy})`}
            fill={sticker.accent ? "var(--accent, currentColor)" : undefined}
            style={{ opacity: `calc(${right} + ${up} * ${LIT.top} + ${left * LIT.left})` }}
          />
        )
      })}
    </svg>
  )
  if (!solvable) return mark
  return (
    <button
      type="button"
      aria-label={t("home.solveCube")}
      onClick={() => play(frame, setPose, false)}
    >
      {mark}
    </button>
  )
}

/** A wait worth a look, such as a model list loading: the cube turning above its label. */
export function CubeLoader({ label }: { label: string }) {
  return (
    <div className="cubeLoader" role="status">
      <OtisMark className="cubeLoader-mark" decorative looping />
      {label}
    </div>
  )
}
