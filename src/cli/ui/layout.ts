import {
  BoxRenderable,
  InputRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import { localServerNames, supportsOmlx } from "../../inference/types.js"
import { colors } from "../theme.js"
import { formatContextLabel } from "./format.js"
import { createMessagesView, createSidePanel, createStatsRow } from "./panels.js"
import type { ChatUIOptions, Renderer } from "./types.js"

const version = process.env.OTIS_VERSION ?? "dev"
const TOP_BAR_BRAND = " OTIS "
const HOME_PANEL_WIDTH = "78%"
const HOME_PANEL_MAX_WIDTH = 72
const SETUP_CHOICE_PANEL_WIDTH = "92%"
const SETUP_CHOICE_PANEL_MAX_WIDTH = 92
/** Delegated runs list beside the transcript; narrower than the pickers since titles are short. */
const SUBAGENT_PANEL_WIDTH = 34

export type UILayout = ReturnType<typeof createUILayout>

export function setTopBarSideMinWidth(
  start: BoxRenderable,
  end: BoxRenderable,
  paddedContext: string,
) {
  const minWidth = Math.max(TOP_BAR_BRAND.length, paddedContext.length)
  start.minWidth = minWidth
  end.minWidth = minWidth
}

export function setWelcomePanelExpanded(panel: BoxRenderable, expanded: boolean) {
  panel.width = expanded ? SETUP_CHOICE_PANEL_WIDTH : HOME_PANEL_WIDTH
  panel.maxWidth = expanded ? SETUP_CHOICE_PANEL_MAX_WIDTH : HOME_PANEL_MAX_WIDTH
}

export function createUILayout(
  renderer: Renderer,
  options: Pick<
    ChatUIOptions,
    "configured" | "contextLabel" | "modeLabel" | "sessionLabel" | "platform"
  >,
) {
  const { statsRow, statBoxes } = createStatsRow(renderer)
  const { panel: sessionPanel, rows: sessionRowsBox } = createSidePanel(renderer, {
    id: "session",
    header: "Sessions",
    footer: "[↑↓] move · [n] new · [d] delete",
  })
  const { panel: modelPanel, rows: modelRowsBox } = createSidePanel(renderer, {
    id: "model",
    header: "Models",
    footer: "[↑↓] move",
  })
  const {
    panel: subagentPanel,
    rows: subagentRowsBox,
    footer: subagentPanelFooter,
  } = createSidePanel(renderer, {
    id: "subagent",
    header: "Subagents",
    footer: "[→] focus",
    side: "right",
    width: SUBAGENT_PANEL_WIDTH,
  })

  const input = new TextareaRenderable(renderer, {
    id: "otis-input",
    placeholder: "",
    flexGrow: 1,
    flexShrink: 1,
    // Size from leftover row space only; a content-derived basis would let long
    // lines squeeze the mode label and hint beside the input.
    flexBasis: 0,
    minWidth: 1,
    minHeight: 1,
    maxHeight: 10,
    wrapMode: "word",
    scrollMargin: 0,
    textColor: colors.text,
    cursorColor: colors.accent,
    backgroundColor: colors.background,
    focusedBackgroundColor: colors.background,
    focusedTextColor: colors.text,
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      { name: "linefeed", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", shift: true, action: "newline" },
      { name: "linefeed", shift: true, action: "newline" },
      { name: "return", ctrl: true, action: "newline" },
      { name: "kpenter", ctrl: true, action: "newline" },
      { name: "linefeed", ctrl: true, action: "newline" },
    ],
  })
  const modeLabel = new TextRenderable(renderer, {
    id: "mode-label",
    content: options.modeLabel,
    flexShrink: 0,
    fg: colors.accent,
    selectable: false,
  })
  const inputHint = new TextRenderable(renderer, {
    id: "input-hint",
    content: "",
    flexShrink: 1,
    minWidth: 0,
    fg: colors.muted,
    bg: colors.background,
    selectable: false,
    truncate: true,
  })
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    flexDirection: "row",
    // Keep row children at their natural height, pinned to the first input line;
    // the default stretch would let the label and hint wrap as the textarea grows.
    alignItems: "flex-start",
    width: "100%",
    maxWidth: undefined,
    minWidth: 24,
    flexShrink: 0,
    backgroundColor: colors.background,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.border,
    paddingX: 1,
    paddingY: 0,
    gap: 1,
  })
  inputBox.add(modeLabel)
  inputBox.add(input)
  inputBox.add(inputHint)
  const attachments = new TextRenderable(renderer, {
    id: "attachments",
    content: "",
    maxWidth: 30,
    flexShrink: 1,
    fg: colors.accent,
    bg: colors.background,
    truncate: true,
    selectable: false,
  })

  const platform = options.platform ?? process.platform
  const showOmlx = supportsOmlx(platform)
  const servers = localServerNames(platform)
  const serverList = new Intl.ListFormat("en", { type: "disjunction" })
  const setupButtonBox = createSetupColumn(renderer, "setup-box")
  setupButtonBox.add(
    new TextRenderable(renderer, {
      id: "setup-why",
      content: "Your personal AI agent, powered by open models.",
      fg: colors.text,
      selectable: false,
    }),
  )
  setupButtonBox.add(
    new TextRenderable(renderer, {
      id: "setup-local",
      content: "Inspect files, edit code, run commands, and search the web.",
      fg: colors.muted,
      selectable: false,
      wrapMode: "word",
    }),
  )
  const setupStartButton = createAccentButton(renderer, "setup-button", "Set up Otis")
  setupButtonBox.add(setupStartButton)

  const setupChoiceBox = createSetupColumn(renderer, "setup-choice")
  setupChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-choice-heading",
      content: "Choose where Otis thinks",
      fg: colors.text,
      selectable: false,
    }),
  )
  const setupChoiceCards = createChoiceCardRow(renderer, "setup-choice-cards")
  const setupLocalCard = createInferenceChoiceCard(renderer, {
    id: "setup-choice-local",
    title: "Local inference",
    label: "Private, on your devices",
    description: "Run on this machine or connect to a local model server.",
    details: [
      "Managed llama.cpp built in.",
      `${new Intl.ListFormat("en").format([...servers, "NVIDIA PAIR"])}.`,
    ],
  })
  const setupHostedCard = createInferenceChoiceCard(renderer, {
    id: "setup-choice-hosted",
    title: "Hosted inference",
    label: "Powered by Fireworks",
    description: "Fast remote inference with no local hardware requirements.",
    details: [
      "Zero Data Retention by default.",
      "Uses your own Fireworks API key.",
      "Configure it anytime in Settings.",
    ],
  })
  setupChoiceCards.add(setupLocalCard)
  setupChoiceCards.add(setupHostedCard)
  setupChoiceBox.add(setupChoiceCards)
  const setupChoiceMessage = createSetupMessage(renderer, "setup-choice-message", colors.pink)
  setupChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-choice-hint",
      content: "[←→] move · [enter] select",
      fg: colors.muted,
      selectable: false,
    }),
  )

  const setupLocalChoiceBox = createSetupColumn(renderer, "setup-local-choice")
  setupLocalChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-local-choice-heading",
      content: "Choose local inference type",
      fg: colors.text,
      selectable: false,
    }),
  )
  const setupLocalChoiceCards = createChoiceCardRow(renderer, "setup-local-choice-cards")
  const setupManagedLocalCard = createInferenceChoiceCard(renderer, {
    id: "setup-local-choice-managed",
    title: "This machine",
    label: "Managed by Otis",
    description: "Download a curated model and run it with llama.cpp.",
    details: [
      "Recommended hardware:",
      "Apple silicon · 24 GB+ unified memory",
      "Linux · 24 GB+ RAM",
      "Vulkan GPU · 16 GB+ VRAM",
    ],
  })
  const setupPairCard = createInferenceChoiceCard(renderer, {
    id: "setup-local-choice-pair",
    title: "Local servers",
    label: "Managed by you",
    description: "Connect to a model server already running on this computer.",
    details: [
      `${serverList.format(servers)}.`,
      "NVIDIA PAIR for cluster routing.",
      "Only one working endpoint is required.",
    ],
  })
  setupLocalChoiceCards.add(setupManagedLocalCard)
  setupLocalChoiceCards.add(setupPairCard)
  setupLocalChoiceBox.add(setupLocalChoiceCards)
  const setupLocalChoiceMessage = createSetupMessage(
    renderer,
    "setup-local-choice-message",
    colors.pink,
  )
  setupLocalChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-local-choice-hint",
      content: "[←→] move · [enter] select · [esc] back",
      fg: colors.muted,
      selectable: false,
    }),
  )

  const setupInput = createSetupInput(renderer, "setup-input")
  const setupInputLabel = new TextRenderable(renderer, {
    id: "setup-input-label",
    content: "Fireworks API key",
    fg: colors.accent,
    selectable: false,
  })
  const setupMessage = createSetupMessage(renderer, "setup-message", colors.muted)
  const setupInputBox = createSetupInputBox(renderer, "setup-input-box")
  setupInputBox.add(setupInputLabel)
  setupInputBox.add(setupInput)
  const setupContinueButton = createAccentButton(renderer, "setup-continue", "Continue")
  const setupForm = createSetupColumn(renderer, "setup-form")
  setupForm.add(setupInputBox)
  setupForm.add(setupContinueButton)

  const setupPairForm = createSetupColumn(renderer, "setup-pair-form")
  setupPairForm.add(
    new TextRenderable(renderer, {
      id: "setup-pair-heading",
      content: "Local server endpoints",
      fg: colors.text,
      selectable: false,
    }),
  )
  setupPairForm.add(
    new TextRenderable(renderer, {
      id: "setup-pair-description",
      content: `Connect to ${serverList.format(servers)}. PAIR addresses: PAIR → Endpoints. Only one server is required. Models need at least 64K context.${showOmlx ? " oMLX key: optional; blank keeps the saved key." : ""}`,
      fg: colors.muted,
      selectable: false,
      wrapMode: "word",
    }),
  )
  const setupPairOllamaInput = createSetupInputRow(
    renderer,
    setupPairForm,
    "setup-pair-ollama",
    "Ollama",
  )
  const setupPairLMStudioInput = createSetupInputRow(
    renderer,
    setupPairForm,
    "setup-pair-lmstudio",
    "LM Studio",
  )
  const setupOmlxInput = showOmlx
    ? createSetupInputRow(renderer, setupPairForm, "setup-omlx", "oMLX")
    : undefined
  const setupOmlxKeyInput = showOmlx
    ? createSetupInputRow(renderer, setupPairForm, "setup-omlx-key", "API key")
    : undefined
  const setupPairMessage = createSetupMessage(renderer, "setup-pair-message", colors.muted)
  setupPairForm.add(
    new TextRenderable(renderer, {
      id: "setup-pair-hint",
      content: "[tab] switch field · [enter] continue · [esc] back",
      fg: colors.muted,
      selectable: false,
    }),
  )

  const setupStatusBox = createSetupColumn(renderer, "setup-status-box")
  const setupStatus = new TextRenderable(renderer, {
    id: "setup-status",
    content: "",
    fg: colors.accent,
    selectable: false,
  })
  setupStatusBox.add(setupStatus)

  const welcomePanel = new BoxRenderable(renderer, {
    id: "welcome-panel",
    flexDirection: "column",
    width: HOME_PANEL_WIDTH,
    maxWidth: HOME_PANEL_MAX_WIDTH,
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
  const permissionPrompt = new BoxRenderable(renderer, {
    id: "permission-prompt",
    flexDirection: "column",
    position: "absolute",
    left: 0,
    bottom: 3,
    width: "100%",
    flexShrink: 0,
    backgroundColor: colors.surface,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.yellow,
    paddingX: 1,
    paddingY: 1,
    gap: 0,
  })
  const permissionLabel = new TextRenderable(renderer, {
    id: "permission-label",
    content: " ",
    fg: colors.yellow,
    selectable: false,
    truncate: true,
  })
  permissionPrompt.add(permissionLabel)
  permissionPrompt.add(
    new TextRenderable(renderer, {
      id: "permission-hint",
      content: " [y] allow   [n] deny ",
      fg: colors.muted,
      selectable: false,
    }),
  )
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
    attachments,
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
    setupChoiceBox,
    setupChoiceMessage,
    setupHostedCard,
    setupLocalChoiceBox,
    setupLocalChoiceMessage,
    setupLocalCard,
    setupManagedLocalCard,
    setupPairCard,
    setupPairForm,
    setupPairLMStudioInput,
    setupOmlxInput,
    setupOmlxKeyInput,
    setupPairMessage,
    setupPairOllamaInput,
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
    subagentPanel,
    subagentPanelFooter,
    subagentRowsBox,
    topBar,
    topBarEnd,
    topBarStart,
    updateHint,
    welcome,
    welcomePanel,
    welcomeQuit,
  }
}

/** A full-width centered column that takes the input's slot on the home screen. */
function createSetupColumn(renderer: Renderer, id: string) {
  return new BoxRenderable(renderer, {
    id,
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 1,
  })
}

function createChoiceCardRow(renderer: Renderer, id: string) {
  return new BoxRenderable(renderer, {
    id,
    flexDirection: "row",
    width: "100%",
    minWidth: 1,
    flexShrink: 0,
    alignItems: "stretch",
    gap: 2,
  })
}

function createSetupMessage(renderer: Renderer, id: string, fg: string) {
  return new TextRenderable(renderer, { id, content: "", fg, selectable: false, truncate: true })
}

function createSetupInput(renderer: Renderer, id: string) {
  return new InputRenderable(renderer, {
    id,
    placeholder: "",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 1,
    textColor: colors.text,
    cursorColor: colors.accent,
    backgroundColor: colors.background,
    focusedBackgroundColor: colors.background,
    focusedTextColor: colors.text,
  })
}

function createSetupInputBox(renderer: Renderer, id: string) {
  return new BoxRenderable(renderer, {
    id,
    flexDirection: "row",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    backgroundColor: colors.background,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.border,
    paddingX: 1,
    paddingY: 0,
    gap: 1,
  })
}

/** A labelled endpoint field appended to `form`; returns the input. */
function createSetupInputRow(renderer: Renderer, form: BoxRenderable, id: string, label: string) {
  const input = createSetupInput(renderer, `${id}-input`)
  const box = createSetupInputBox(renderer, `${id}-box`)
  box.add(
    new TextRenderable(renderer, {
      id: `${id}-label`,
      content: label,
      width: 9,
      flexShrink: 0,
      fg: colors.accent,
      selectable: false,
    }),
  )
  box.add(input)
  form.add(box)
  return input
}

function createInferenceChoiceCard(
  renderer: Renderer,
  options: { id: string; title: string; label: string; description: string; details: string[] },
) {
  const card = new BoxRenderable(renderer, {
    id: options.id,
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.border,
    paddingX: 2,
    paddingTop: 1,
    paddingBottom: 0,
    gap: 0,
  })
  card.add(
    new TextRenderable(renderer, {
      id: `${options.id}-title`,
      content: options.title,
      fg: colors.text,
      alignSelf: "center",
      selectable: false,
      wrapMode: "word",
    }),
  )
  card.add(
    new TextRenderable(renderer, {
      id: `${options.id}-label`,
      content: options.label,
      fg: colors.accent,
      alignSelf: "center",
      selectable: false,
      wrapMode: "word",
    }),
  )
  card.add(
    new TextRenderable(renderer, {
      id: `${options.id}-description`,
      content: options.description,
      fg: colors.text,
      marginTop: 1,
      selectable: false,
      wrapMode: "word",
    }),
  )
  options.details.forEach((detail, index) => {
    card.add(
      new TextRenderable(renderer, {
        id: `${options.id}-detail-${index}`,
        content: detail,
        fg: colors.muted,
        ...(index === 0 ? { marginTop: 1 } : {}),
        selectable: false,
        wrapMode: "word",
      }),
    )
  })
  return card
}

function createAccentButton(renderer: Renderer, id: string, label: string) {
  const box = new BoxRenderable(renderer, {
    id: `${id}-box`,
    flexDirection: "row",
    paddingX: 2,
    paddingY: 0,
    backgroundColor: colors.accent,
    flexShrink: 0,
    marginTop: 1,
  })
  box.add(
    new TextRenderable(renderer, {
      id,
      content: ` ${label} `,
      fg: colors.background,
      bg: colors.accent,
      selectable: false,
    }),
  )
  return box
}
