import { BoxRenderable, InputRenderable, MouseButton, TextareaRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

export function createChatInput(renderer: Renderer, label: string) {
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
    content: label,
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
  return { input, inputBox, inputHint, modeLabel }
}

export function createSetupViews(renderer: Renderer) {
  const setupButtonBox = new BoxRenderable(renderer, {
    id: "setup-box",
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 1,
  })
  setupButtonBox.add(
    new TextRenderable(renderer, {
      id: "setup-why",
      content: "Your terminal agent, powered by open models.",
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

  const setupChoiceBox = new BoxRenderable(renderer, {
    id: "setup-choice",
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 1,
  })
  setupChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-choice-heading",
      content: "Choose how Otis runs models",
      fg: colors.text,
      selectable: false,
    }),
  )

  const setupChoiceCards = new BoxRenderable(renderer, {
    id: "setup-choice-cards",
    flexDirection: "row",
    width: "100%",
    minWidth: 1,
    flexShrink: 0,
    alignItems: "stretch",
    gap: 2,
  })
  const setupLocalCard = createInferenceChoiceCard(renderer, {
    id: "setup-choice-local",
    title: "Local inference",
    label: "Runs on your machine",
    description: "Run open models on your own hardware.",
    details: [
      "Recommended hardware:",
      "Apple silicon · 24 GB+ unified memory",
      "Linux · 24 GB+ RAM",
      "Vulkan GPU · 16 GB+ VRAM",
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
  const setupChoiceMessage = new TextRenderable(renderer, {
    id: "setup-choice-message",
    content: "",
    fg: colors.pink,
    selectable: false,
    truncate: true,
  })
  setupChoiceBox.add(
    new TextRenderable(renderer, {
      id: "setup-choice-hint",
      content: "[←→] move · [enter] select",
      fg: colors.muted,
      selectable: false,
    }),
  )

  const setupInput = new InputRenderable(renderer, {
    id: "setup-input",
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
  const setupInputLabel = new TextRenderable(renderer, {
    id: "setup-input-label",
    content: "Fireworks API key",
    fg: colors.accent,
    selectable: false,
  })
  const setupMessage = new TextRenderable(renderer, {
    id: "setup-message",
    content: "",
    fg: colors.muted,
    selectable: false,
    truncate: true,
  })
  const setupInputBox = new BoxRenderable(renderer, {
    id: "setup-input-box",
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
  setupInputBox.add(setupInputLabel)
  setupInputBox.add(setupInput)

  const setupContinueButton = createAccentButton(renderer, "setup-continue", "Continue")
  const setupForm = new BoxRenderable(renderer, {
    id: "setup-form",
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 1,
  })
  setupForm.add(setupInputBox)
  setupForm.add(setupContinueButton)

  const setupStatusBox = new BoxRenderable(renderer, {
    id: "setup-status-box",
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 1,
  })
  const setupStatus = new TextRenderable(renderer, {
    id: "setup-status",
    content: "",
    fg: colors.accent,
    selectable: false,
  })
  setupStatusBox.add(setupStatus)

  return {
    setupButtonBox,
    setupChoiceBox,
    setupChoiceMessage,
    setupHostedCard,
    setupLocalCard,
    setupContinueButton,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStartButton,
    setupStatus,
    setupStatusBox,
  }
}

type InferenceChoiceCardOptions = {
  id: string
  title: string
  label: string
  description: string
  details: string[]
}

function createInferenceChoiceCard(renderer: Renderer, options: InferenceChoiceCardOptions) {
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
  const title = new TextRenderable(renderer, {
    id: `${options.id}-title`,
    content: options.title,
    fg: colors.text,
    alignSelf: "center",
    selectable: false,
    wrapMode: "word",
  })
  card.add(title)
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

export function createPermissionPrompt(renderer: Renderer) {
  const prompt = new BoxRenderable(renderer, {
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
  const label = new TextRenderable(renderer, {
    id: "permission-label",
    content: " ",
    fg: colors.yellow,
    selectable: false,
    truncate: true,
  })
  prompt.add(label)
  prompt.add(
    new TextRenderable(renderer, {
      id: "permission-hint",
      content: " [y] allow   [n] deny ",
      fg: colors.muted,
      selectable: false,
    }),
  )
  return { prompt, label }
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

export function bindAccentButton(button: BoxRenderable, renderer: Renderer, action: () => void) {
  const activate = (event: { button: number; preventDefault(): void; stopPropagation(): void }) => {
    if (event.button !== MouseButton.LEFT) return
    event.preventDefault()
    event.stopPropagation()
    action()
  }
  const bind = (node: BoxRenderable | TextRenderable) => {
    node.onMouseDown = activate
    node.onMouseOver = () => renderer.setMousePointer("pointer")
    node.onMouseOut = () => renderer.setMousePointer("default")
    if (!(node instanceof BoxRenderable)) return
    for (const child of node.getChildren()) {
      if (child instanceof BoxRenderable || child instanceof TextRenderable) bind(child)
    }
  }
  bind(button)
}
