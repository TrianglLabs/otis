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
const SUBAGENT_PANEL_WIDTH = 34

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
  const statBoxes: Array<{ value: TextRenderable; label: TextRenderable }> = []

  for (let index = 0; index < 4; index += 1) {
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
      content: initialStats[index].value,
      fg: colors.accent,
      attributes,
      alignSelf: "center",
    })
    const label = new TextRenderable(renderer, {
      id: `welcome-stat-label-${index}`,
      content: initialStats[index].label,
      fg: colors.muted,
      alignSelf: "center",
    })
    box.add(value)
    box.add(label)
    statsRow.add(box)
    statBoxes.push({ value, label })
  }

  return { statsRow, statBoxes }
}

export function createSessionPanel(renderer: Renderer) {
  return createSidePanel(renderer, {
    id: "session-panel",
    headerId: "session-panel-header",
    rowsId: "session-rows",
    footerId: "session-panel-footer",
    header: "Sessions",
    footer: "[↑↓] move · [n] new · [d] delete",
  })
}

export function createModelPanel(renderer: Renderer) {
  return createSidePanel(renderer, {
    id: "model-panel",
    headerId: "model-panel-header",
    rowsId: "model-rows",
    footerId: "model-panel-footer",
    header: "Models",
    footer: "[↑↓] move",
  })
}

/** Delegated runs list beside the transcript; narrower than the pickers because titles are 3-7 words. */
export function createSubagentPanel(renderer: Renderer) {
  return createSidePanel(renderer, {
    id: "subagent-panel",
    headerId: "subagent-panel-header",
    rowsId: "subagent-rows",
    footerId: "subagent-panel-footer",
    header: "Subagents",
    footer: "click a run to inspect",
    side: "right",
    width: SUBAGENT_PANEL_WIDTH,
  })
}

function createSidePanel(
  renderer: Renderer,
  spec: {
    id: string
    headerId: string
    rowsId: string
    footerId: string
    header: string
    footer: string
    side?: "left" | "right"
    width?: number
  },
) {
  const panel = new BoxRenderable(renderer, {
    id: spec.id,
    flexDirection: "column",
    width: spec.width ?? SIDE_PANEL_WIDTH,
    minWidth: Math.min(SIDE_PANEL_MIN_WIDTH, spec.width ?? SIDE_PANEL_WIDTH),
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
    id: spec.rowsId,
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
      id: spec.headerId,
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
    id: spec.footerId,
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
