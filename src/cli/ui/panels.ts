import {
  BoxRenderable,
  createTextAttributes,
  LinearScrollAccel,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
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

export function createStatsRow(renderer: Renderer) {
  const initialStats = [
    { value: "0", label: "day streak" },
    { value: "0", label: "all-time tokens" },
    { value: "0", label: "tokens/session" },
    { value: "0S", label: "time/session" },
  ]
  // 4 cards x 19 + 3 gaps x 1 = 79: an exact fit, so yoga never splits
  // fractional cells across the cards (which made widths and gaps uneven).
  const statsRow = new BoxRenderable(renderer, {
    id: "welcome-stats-row",
    flexDirection: "row",
    alignSelf: "center",
    width: "100%",
    maxWidth: 79,
    flexShrink: 0,
    marginTop: 2,
    gap: 1,
  })
  const attributes = createTextAttributes({ bold: true })
  const statBoxes = initialStats.map((stat, index) => {
    const box = new BoxRenderable(renderer, {
      id: `welcome-stat-${index}`,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      // Longest label ("all-time tokens", 15) + paddingX 2 + border 2 = 19.
      flexBasis: 19,
      flexShrink: 1,
      paddingX: 1,
      paddingY: 1,
      border: true,
      borderColor: colors.border,
      borderStyle: "rounded",
    })
    const value = new TextRenderable(renderer, {
      id: `welcome-stat-value-${index}`,
      content: stat.value,
      fg: colors.accent,
      attributes,
      alignSelf: "center",
    })
    const label = new TextRenderable(renderer, {
      id: `welcome-stat-label-${index}`,
      content: stat.label,
      fg: colors.muted,
      alignSelf: "center",
    })
    box.add(value)
    box.add(label)
    statsRow.add(box)
    return { value, label }
  })
  return { statsRow, statBoxes }
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
