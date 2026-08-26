import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { formatContextLabel } from "./format.js"
import { createChatInput, createPermissionPrompt, createSetupViews } from "./input-views.js"
import { createMessagesView, createModelPanel, createSessionPanel, createStatsRow } from "./panels.js"
import type { ChatUIOptions, Renderer } from "./types.js"

const version = process.env.OTIS_VERSION ?? "dev"
const TOP_BAR_BRAND = " OTIS "

export function setTopBarSideMinWidth(start: BoxRenderable, end: BoxRenderable, paddedContext: string) {
  const minWidth = Math.max(TOP_BAR_BRAND.length, paddedContext.length)
  start.minWidth = minWidth
  end.minWidth = minWidth
}

export function createUILayout(
  renderer: Renderer,
  options: Pick<ChatUIOptions, "configured" | "contextLabel" | "modeLabel" | "sessionLabel">,
) {
  const { statsRow, statBoxes } = createStatsRow(renderer)
  const { panel: sessionPanel, rows: sessionRowsBox } = createSessionPanel(renderer)
  const { panel: modelPanel, rows: modelRowsBox } = createModelPanel(renderer)
  const { input, inputBox, inputHint, modeLabel } = createChatInput(renderer, options.modeLabel)
  const imageAttachments = new TextRenderable(renderer, {
    id: "image-attachments",
    content: "",
    maxWidth: 30,
    flexShrink: 1,
    fg: colors.accent,
    bg: colors.background,
    truncate: true,
    selectable: false,
  })
  const {
    setupButtonBox,
    setupContinueButton,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStartButton,
    setupStatus,
    setupStatusBox,
  } = createSetupViews(renderer)

  const welcomePanel = new BoxRenderable(renderer, {
    id: "welcome-panel",
    flexDirection: "column",
    width: "78%",
    maxWidth: 72,
    minWidth: 30,
    flexShrink: 0,
    alignSelf: "center",
    backgroundColor: colors.background,
    paddingX: 2,
    paddingY: 0,
    marginTop: 2,
    gap: 1,
  })
  const welcomeQuit = new TextRenderable(renderer, {
    id: "welcome-quit",
    content: options.configured === false ? " " : "/ for commands",
    fg: colors.muted,
    alignSelf: "center",
  })
  // The spacers split free space equally to center the content when it fits.
  // When the input grows past the available height, they collapse to zero and
  // flex-end anchoring clips the decorative top (brand, then stats) while the
  // fixed-size children keep their natural height instead of being squashed.
  const welcomeTopSpacer = new BoxRenderable(renderer, {
    id: "welcome-spacer-top",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  })
  const welcomeBottomSpacer = new BoxRenderable(renderer, {
    id: "welcome-spacer-bottom",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  })
  const welcome = new BoxRenderable(renderer, {
    id: "welcome",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    backgroundColor: RGBA.fromValues(0, 0, 0, 0),
    gap: 0,
  })
  const inputArea = new BoxRenderable(renderer, {
    id: "input-area",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
  })
  inputArea.add(options.configured === false ? setupButtonBox : inputBox)
  welcomePanel.add(inputArea)
  welcomePanel.add(welcomeQuit)
  welcome.add(welcomeTopSpacer)
  // The art is wrapped in a box because a bare TextRenderable child adds a
  // phantom row to the following gap in a gapped column; boxing it keeps the
  // brand -> stats spacing equal to stats -> input spacing.
  const welcomeBrand = new BoxRenderable(renderer, {
    id: "welcome-brand",
    flexDirection: "column",
    alignSelf: "center",
    flexShrink: 0,
  })
  welcomeBrand.add(
    new TextRenderable(renderer, {
      id: "welcome-brand-art",
      content: [
        "   ____  _______________",
        "  / __ \\/_  __/  _/ ___/",
        " / / / / / /  / / \\__ \\",
        "/ /_/ / / / _/ / ___/ /",
        "\\____/ /_/ /___//____/",
      ].join("\n"),
      fg: colors.accent,
    }),
  )
  welcome.add(welcomeBrand)
  if (options.configured !== false) welcome.add(statsRow)
  welcome.add(welcomePanel)
  welcome.add(welcomeBottomSpacer)
  welcome.add(
    new TextRenderable(renderer, {
      id: "welcome-version",
      content: `v${version}`,
      fg: colors.muted,
      position: "absolute",
      bottom: 0,
      left: 0,
    }),
  )

  const paddedContext = formatContextLabel(options.contextLabel)
  const topBar = new BoxRenderable(renderer, {
    id: "top-bar",
    flexDirection: "row",
    width: "100%",
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    paddingBottom: 1,
  })
  const topBarStart = new BoxRenderable(renderer, {
    id: "top-bar-start",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 0,
    alignItems: "center",
  })
  topBarStart.add(
    new TextRenderable(renderer, {
      id: "title-bar",
      content: TOP_BAR_BRAND,
      fg: colors.accent,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    }),
  )
  const sessionSlot = new BoxRenderable(renderer, {
    id: "session-slot",
    flexDirection: "row",
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  })
  const sessionLabel = new TextRenderable(renderer, {
    id: "session-label",
    content: options.sessionLabel,
    fg: colors.muted,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
    wrapMode: "none",
    truncate: true,
    selectable: false,
  })
  sessionSlot.add(sessionLabel)
  const contextLabel = new TextRenderable(renderer, {
    id: "context-label",
    content: paddedContext,
    fg: colors.muted,
    flexShrink: 0,
    wrapMode: "none",
    selectable: false,
  })
  const topBarEnd = new BoxRenderable(renderer, {
    id: "top-bar-end",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 0,
    justifyContent: "flex-end",
    alignItems: "center",
  })
  topBarEnd.add(contextLabel)
  setTopBarSideMinWidth(topBarStart, topBarEnd, paddedContext)
  topBar.add(topBarStart)
  topBar.add(sessionSlot)
  topBar.add(topBarEnd)

  const commandMenu = new BoxRenderable(renderer, {
    id: "command-menu",
    flexDirection: "column",
    position: "absolute",
    left: 0,
    bottom: 3,
    width: "100%",
    flexShrink: 0,
    backgroundColor: colors.background,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.border,
    paddingX: 1,
    paddingY: 1,
    gap: 0,
  })
  const { prompt: permissionPrompt, label: permissionLabel } = createPermissionPrompt(renderer)
  const messages = createMessagesView(renderer)
  const chatBody = new BoxRenderable(renderer, {
    id: "chat-body",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 1,
    width: "100%",
    backgroundColor: colors.background,
  })
  const agentBar = new TextRenderable(renderer, {
    id: "agent-bar",
    content: " ",
    width: "100%",
    flexShrink: 0,
    marginTop: 1,
    fg: colors.accent,
    bg: colors.background,
    truncate: true,
    selectable: false,
  })
  const updateHint = new TextRenderable(renderer, {
    id: "update-hint",
    content: " ",
    fg: colors.yellow,
    alignSelf: "center",
    flexShrink: 0,
    selectable: false,
    truncate: true,
  })
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: colors.background,
    live: true,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 1,
    paddingRight: 0,
    gap: 0,
  })
  root.add(welcome)
  renderer.root.add(root)

  return {
    agentBar,
    chatBody,
    commandMenu,
    contextLabel,
    input,
    inputArea,
    inputBox,
    inputHint,
    imageAttachments,
    messages,
    modelPanel,
    modelRowsBox,
    modeLabel,
    permissionLabel,
    permissionPrompt,
    root,
    sessionLabel,
    sessionPanel,
    sessionRowsBox,
    setupButtonBox,
    setupContinueButton,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStartButton,
    setupStatus,
    setupStatusBox,
    statBoxes,
    statsRow,
    topBar,
    topBarEnd,
    topBarStart,
    updateHint,
    welcome,
    welcomePanel,
    welcomeQuit,
  }
}

/** Persistent layout renderables, including trees that home/chat may unmount. */
export function themeRootsFrom(layout: ReturnType<typeof createUILayout>) {
  const roots: Array<{ getChildren(): unknown[] }> = []
  for (const value of Object.values(layout)) {
    if (isThemeRoot(value)) roots.push(value)
  }
  return roots
}

function isThemeRoot(value: unknown): value is { getChildren(): unknown[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "getChildren" in value
}
