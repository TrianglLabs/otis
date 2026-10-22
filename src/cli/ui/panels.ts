import {
  BoxRenderable,
  createTextAttributes,
  fg,
  LinearScrollAccel,
  ScrollBoxRenderable,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import { mixHex } from "./color-pulse.js"
import type { Renderer } from "./types.js"

const SIDE_PANEL_WIDTH = 41
const SIDE_PANEL_MIN_WIDTH = 30

// OpenTUI's scrollbar slider hardcodes a dark track (#252527) and gray thumb
// (#9a9ea3); recolor both from the active theme so they stay visible.
export function createScrollbarOptions() {
  return {
    trackOptions: {
      backgroundColor: colors.border,
      foregroundColor: colors.muted,
    },
  }
}

/**
 * The Otis mark as dot art: the desktop cube of three faces, 3×3 tiles each, with the O cut from
 * the front face, drawn on a dot grid so every tile gap stays crisp. Tiles are MARK_TILE dots wide
 * with MARK_GAP-dot gaps, so a face spans MARK_FACE dots and the cube is twice that plus a gap.
 * The top rhombus is classic 2:1 isometric, tested in doubled coordinates to keep its diagonals
 * even; the side faces hang one gap below its lower edges. Returns one face index per dot: 0
 * empty, 1 top, 2 left, 3 front.
 */
const MARK_TILE = 5
const MARK_GAP = 2
const MARK_FACE = 3 * MARK_TILE + 2 * MARK_GAP
export const MARK_SIZE = 2 * MARK_FACE + MARK_GAP

export function markDots() {
  const pitch = MARK_TILE + MARK_GAP
  const centre = MARK_FACE + MARK_GAP / 2 - 0.5
  const inTile = (u: number, v: number, scale = 1) =>
    u >= 0 &&
    v >= 0 &&
    u < MARK_FACE * scale &&
    v < MARK_FACE * scale &&
    u % (pitch * scale) < MARK_TILE * scale &&
    v % (pitch * scale) < MARK_TILE * scale
  const dots = Array.from({ length: MARK_SIZE }, () => new Array<number>(MARK_SIZE).fill(0))
  for (let x = 0; x < MARK_SIZE; x++) {
    const dx = x - centre
    for (let dy = 0; dy < MARK_FACE; dy++) {
      if (inTile(dx + 2 * dy, 2 * dy - dx, 2)) dots[dy][x] = 1
    }
    const left = x < MARK_FACE
    if (!left && x < MARK_FACE + MARK_GAP) continue
    const u = left ? x : x - MARK_FACE - MARK_GAP
    const top = Math.ceil(MARK_FACE - Math.abs(dx) / 2) + MARK_GAP
    for (let v = 0; v < MARK_FACE; v++) {
      const hole = !left && Math.floor(u / pitch) === 1 && Math.floor(v / pitch) === 1
      if (inTile(u, v) && !hole && top + v < MARK_SIZE) dots[top + v][x] = left ? 2 : 3
    }
  }
  return dots
}

/** Braille dot bits by [row][column] within a cell. */
const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
const MARK_FADE = 0.35

/**
 * The mark in the current theme as braille: each cell carries a 2×4 patch of dots in the colour
 * of the face owning most of them. The top and left faces are text ink washed into the background
 * at the desktop mark's opacities, the O face is the accent, and every face fades a little toward
 * the background down the cube.
 */
export function markArt() {
  const shade = [
    colors.background,
    mixHex(colors.background, colors.text, 0.7),
    mixHex(colors.background, colors.text, 0.45),
    colors.accent,
  ]
  const dots = markDots()
  const rows = MARK_SIZE / 4
  const chunks: TextChunk[] = []
  for (let row = 0; row < rows; row++) {
    if (row) chunks.push(fg(colors.background)("\n"))
    for (let column = 0; column < MARK_SIZE / 2; column++) {
      let code = 0
      const count = [0, 0, 0, 0]
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
          const face = dots[row * 4 + y][column * 2 + x]
          if (!face) continue
          code |= BRAILLE[y][x]
          count[face]++
        }
      }
      const face = count.indexOf(Math.max(...count))
      const color = mixHex(shade[face], colors.background, (MARK_FADE * row) / (rows - 1))
      chunks.push(fg(color)(code ? String.fromCharCode(0x2800 + code) : " "))
    }
  }
  return new StyledText(chunks)
}

/** Days in the activity chart, each a one-cell bar with a one-cell gap. */
export const ACTIVITY_DAYS = 28
const ACTIVITY_ROWS = 3
export const ACTIVITY_WIDTH = ACTIVITY_DAYS * 2 - 1
/** Bar heights in eighths of a row; the tallest leaves one eighth of air. */
const ACTIVITY_PEAK = ACTIVITY_ROWS * 8 - 1
const ACTIVITY_FADE = 0.45
const EIGHTHS = " ▁▂▃▄▅▆▇█"

/**
 * The home screen's usage block: the four metrics as value-over-label pairs spread across the
 * chart's width, the last four weeks of tokens as braille bars, and a caption with the date
 * range and today's tokens. It mirrors the desktop usage card without borders.
 */
export function createStatsRow(renderer: Renderer) {
  const initialStats = [
    { value: "0", label: "day streak" },
    { value: "0", label: "total tokens" },
    { value: "0", label: "tokens/session" },
    { value: "0S", label: "time/session" },
  ]
  const statsRow = new BoxRenderable(renderer, {
    id: "welcome-stats-row",
    flexDirection: "column",
    alignSelf: "center",
    alignItems: "center",
    flexShrink: 0,
    marginTop: 3,
  })
  // Four metrics separated by two-row rules; the chart and caption centre beneath them.
  const metrics = new BoxRenderable(renderer, {
    id: "welcome-stats-metrics",
    flexDirection: "row",
    gap: 1,
  })
  const attributes = createTextAttributes({ bold: true })
  const statBoxes = initialStats.map((stat, index) => {
    if (index) {
      metrics.add(
        new TextRenderable(renderer, {
          id: `welcome-stat-divider-${index}`,
          content: "│\n│",
          fg: colors.border,
          selectable: false,
        }),
      )
    }
    const box = new BoxRenderable(renderer, {
      id: `welcome-stat-${index}`,
      flexDirection: "column",
      alignItems: "center",
    })
    const value = new TextRenderable(renderer, {
      id: `welcome-stat-value-${index}`,
      content: stat.value,
      fg: colors.accent,
      attributes,
    })
    const label = new TextRenderable(renderer, {
      id: `welcome-stat-label-${index}`,
      content: stat.label,
      fg: colors.muted,
    })
    box.add(value)
    box.add(label)
    metrics.add(box)
    return { value, label }
  })
  const chart = new TextRenderable(renderer, {
    id: "welcome-stats-chart",
    content: activityArt([], []),
    marginTop: 1,
    selectable: false,
  })
  const caption = new BoxRenderable(renderer, {
    id: "welcome-stats-caption",
    flexDirection: "row",
    justifyContent: "space-between",
    width: ACTIVITY_WIDTH,
  })
  const range = new TextRenderable(renderer, { id: "welcome-stats-range", fg: colors.muted })
  const today = new TextRenderable(renderer, { id: "welcome-stats-today", fg: colors.muted })
  caption.add(range)
  caption.add(today)
  statsRow.add(metrics)
  statsRow.add(chart)
  statsRow.add(caption)
  return { statsRow, statBoxes, chart, range, today }
}

/**
 * Daily token bars, each scaled by its `grown` amount from 0 to 1 for the count-up. Days are
 * right-aligned so a short history leaves empty days on the left; an empty day shows a baseline
 * stub in the border colour, like the desktop chart. Each bar fades toward the background as
 * it goes down from its own top, since a braille cell carries one colour.
 */
export function activityArt(days: { tokens: number }[], grown: number[]) {
  const tokens = Array.from(
    { length: ACTIVITY_DAYS },
    (_, day) => days[day - ACTIVITY_DAYS + days.length]?.tokens ?? 0,
  )
  const peak = Math.max(1, ...tokens)
  const heights = tokens.map((count, day) =>
    count ? Math.max(1, Math.round((ACTIVITY_PEAK * count * grown[day]) / peak)) : 1,
  )
  const chunks: TextChunk[] = []
  for (let row = 0; row < ACTIVITY_ROWS; row++) {
    if (row) chunks.push(fg(colors.background)("\n"))
    for (let day = 0; day < ACTIVITY_DAYS; day++) {
      const fill = Math.min(8, Math.max(0, heights[day] - (ACTIVITY_ROWS - 1 - row) * 8))
      const depth = row - Math.floor((ACTIVITY_ROWS * 8 - heights[day]) / 8)
      const color = tokens[day]
        ? mixHex(colors.accent, colors.background, (ACTIVITY_FADE * depth) / 2)
        : colors.border
      chunks.push(fg(color)(EIGHTHS[fill] + (day < ACTIVITY_DAYS - 1 ? " " : "")))
    }
  }
  return new StyledText(chunks)
}

/**
 * A header, scrolling rows, and keyboard-helper footer beside the transcript, e.g. `session` →
 * `session-panel`.
 */
export function createSidePanel(
  renderer: Renderer,
  spec: { id: string; header: string; footer: string; side?: "left" | "right"; width?: number },
) {
  const width = spec.width ?? SIDE_PANEL_WIDTH
  const panel = new BoxRenderable(renderer, {
    id: `${spec.id}-panel`,
    flexDirection: "column",
    width,
    minWidth: Math.min(SIDE_PANEL_MIN_WIDTH, width),
    flexShrink: 0,
    height: "100%",
    backgroundColor: colors.surface,
    paddingLeft: 1,
    paddingRight: 0,
    paddingY: 1,
    gap: 0,
    ...(spec.side === "right" ? { marginLeft: 1, marginRight: 1 } : { marginRight: 1 }),
  })
  const rows = new ScrollBoxRenderable(renderer, {
    id: `${spec.id}-rows`,
    flexGrow: 1,
    flexShrink: 1,
    // Leftover column space only; a content-sized basis lets a long list
    // squeeze the header and keyboard-helper footer.
    flexBasis: 0,
    minHeight: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: colors.surface,
    contentOptions: { flexDirection: "column", backgroundColor: colors.surface },
    verticalScrollbarOptions: createScrollbarOptions(),
  })
  panel.add(
    new TextRenderable(renderer, {
      id: `${spec.id}-panel-header`,
      content: spec.header,
      fg: colors.accent,
      bg: colors.surface,
      marginBottom: 1,
      flexShrink: 0,
      selectable: false,
    }),
  )
  panel.add(rows)
  const footer = new TextRenderable(renderer, {
    id: `${spec.id}-panel-footer`,
    content: spec.footer,
    fg: colors.muted,
    bg: colors.surface,
    marginTop: 1,
    flexShrink: 0,
    selectable: false,
    truncate: true,
  })
  panel.add(footer)
  return { panel, rows, footer }
}

export function createMessagesView(renderer: Renderer, id = "messages") {
  return new ScrollBoxRenderable(renderer, {
    id,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    scrollAcceleration: new LinearScrollAccel(),
    backgroundColor: colors.background,
    contentOptions: {
      flexDirection: "column",
      gap: 0,
      justifyContent: "flex-end",
      backgroundColor: colors.background,
    },
    viewportOptions: { backgroundColor: colors.background },
    rootOptions: { backgroundColor: colors.background },
    verticalScrollbarOptions: createScrollbarOptions(),
  })
}
