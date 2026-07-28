import {
  BoxRenderable,
  createTextAttributes,
  LinearScrollAccel,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

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
  const statsRow = new BoxRenderable(renderer, {
    id: "welcome-stats-row",
    flexDirection: "row",
    alignSelf: "center",
    width: "100%",
    maxWidth: 80,
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
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
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
  const panel = new BoxRenderable(renderer, {
    id: "session-panel",
    flexDirection: "column",
    width: 41,
    minWidth: 30,
    flexShrink: 0,
    height: "100%",
    backgroundColor: colors.surface,
    paddingX: 1,
    paddingY: 1,
    gap: 0,
    marginRight: 1,
  })
  const rows = new ScrollBoxRenderable(renderer, {
    id: "session-rows",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: colors.surface,
    contentOptions: { flexDirection: "column", backgroundColor: colors.surface },
    verticalScrollbarOptions: createScrollbarOptions(),
  })
  panel.add(
    new TextRenderable(renderer, {
      id: "session-panel-header",
      content: "Sessions",
      fg: colors.accent,
      bg: colors.surface,
      marginBottom: 1,
      selectable: false,
    }),
  )
  panel.add(rows)
  panel.add(
    new TextRenderable(renderer, {
      id: "session-panel-footer",
      content: "[↑↓] select  [Enter] open\n[n] new  [d] delete  [Esc] close",
      fg: colors.muted,
      bg: colors.surface,
      marginTop: 1,
      selectable: false,
      truncate: true,
    }),
  )
  return { panel, rows }
}

export function createModelPanel(renderer: Renderer) {
  const panel = new BoxRenderable(renderer, {
    id: "model-panel",
    flexDirection: "column",
    width: 54,
    minWidth: 34,
    flexShrink: 0,
    height: "100%",
    backgroundColor: colors.surface,
    paddingX: 1,
    paddingY: 1,
    gap: 0,
    marginRight: 1,
  })
  const rows = new ScrollBoxRenderable(renderer, {
    id: "model-rows",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: colors.surface,
    contentOptions: { flexDirection: "column", backgroundColor: colors.surface },
    verticalScrollbarOptions: createScrollbarOptions(),
  })
  panel.add(
    new TextRenderable(renderer, {
      id: "model-panel-header",
      content: "Choose a model · context window",
      fg: colors.accent,
      bg: colors.surface,
      marginBottom: 1,
      selectable: false,
    }),
  )
  panel.add(rows)
  panel.add(
    new TextRenderable(renderer, {
      id: "model-panel-footer",
      content: "[↑↓] select  [Enter] use model  [Esc] close",
      fg: colors.muted,
      bg: colors.surface,
      marginTop: 1,
      selectable: false,
      truncate: true,
    }),
  )
  return { panel, rows }
}

export function createMessagesView(renderer: Renderer) {
  return new ScrollBoxRenderable(renderer, {
    id: "messages",
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
