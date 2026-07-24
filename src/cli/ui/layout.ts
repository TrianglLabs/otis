import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { createChatInput, createPermissionPrompt, createSetupViews } from "./input-views.js"
import { createMessagesView, createModelPanel, createSessionPanel, createStatsRow } from "./panels.js"
import type { ChatUIOptions, Renderer } from "./types.js"

const version = process.env.OTIS_VERSION ?? "dev"

export function createUILayout(
  renderer: Renderer,
  options: Pick<ChatUIOptions, "configured" | "contextLabel" | "modeLabel" | "sessionLabel" | "statsVisible">,
) {
  const { statsRow, statBoxes } = createStatsRow(renderer)
  const { panel: sessionPanel, rows: sessionRowsBox } = createSessionPanel(renderer)
  const { panel: modelPanel, rows: modelRowsBox } = createModelPanel(renderer)
  const { input, inputBox, inputHint, modeLabel } = createChatInput(renderer, options.modeLabel)
  const { setupButtonBox, setupForm, setupInput, setupInputLabel, setupMessage, setupStatus, setupStatusBox } =
    createSetupViews(renderer)

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
    marginTop: 1,
    gap: 1,
  })
  const welcomeQuit = new TextRenderable(renderer, {
    id: "welcome-quit",
    content: options.configured === false ? " " : "/ for commands",
    fg: colors.muted,
    alignSelf: "center",
  })
  const welcome = new BoxRenderable(renderer, {
    id: "welcome",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: RGBA.fromValues(0, 0, 0, 0),
    gap: 1,
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
  welcome.add(
    new TextRenderable(renderer, {
      id: "welcome-brand",
      content: ["┏━┓ ━┳━ ╻ ┏━┓", "┃ ┃  ┃  ┃ ┗━┓", "┗━┛  ╹  ╹ ┗━┛"].join("\n"),
      fg: colors.accent,
      alignSelf: "center",
    }),
  )
  if (options.statsVisible ?? options.configured !== false) welcome.add(statsRow)
  welcome.add(welcomePanel)
  welcome.add(
    new TextRenderable(renderer, {
      id: "welcome-version",
      content: `v${version}`,
      fg: "#4E4E4E",
      position: "absolute",
      bottom: 0,
      left: 0,
    }),
  )

  const topBar = new BoxRenderable(renderer, {
    id: "top-bar",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    backgroundColor: colors.background,
    paddingBottom: 1,
  })
  const contextLabel = new TextRenderable(renderer, {
    id: "context-label",
    content: ` ${options.contextLabel} `,
    fg: colors.muted,
    position: "absolute",
    top: 0,
    right: 0,
  })
  const sessionLabel = new TextRenderable(renderer, {
    id: "session-label",
    content: options.sessionLabel,
    fg: colors.muted,
    alignSelf: "center",
    truncate: true,
    selectable: false,
  })
  topBar.add(
    new TextRenderable(renderer, {
      id: "title-bar",
      content: " OTIS ",
      fg: colors.accent,
      position: "absolute",
      top: 0,
      left: 0,
    }),
  )
  topBar.add(sessionLabel)
  topBar.add(contextLabel)

  const commandMenu = new BoxRenderable(renderer, {
    id: "command-menu",
    flexDirection: "column",
    position: "absolute",
    left: 0,
    bottom: 3,
    width: "100%",
    flexShrink: 0,
    backgroundColor: colors.surface,
    border: true,
    borderStyle: "rounded",
    borderColor: "#3A3A3A",
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
    padding: 1,
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
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStatus,
    setupStatusBox,
    statBoxes,
    statsRow,
    topBar,
    updateHint,
    welcome,
    welcomePanel,
    welcomeQuit,
  }
}
