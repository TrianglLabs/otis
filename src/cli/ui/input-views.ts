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
      content: "Otis uses Fireworks as its inference provider.",
      fg: colors.muted,
      selectable: false,
    }),
  )
  setupButtonBox.add(
    new TextRenderable(renderer, {
      id: "setup-local",
      content: "Your key and sessions stay on this machine.",
      fg: colors.muted,
      selectable: false,
    }),
  )
  const setupStartButton = createAccentButton(renderer, "setup-button", "Set up Otis")
  setupButtonBox.add(setupStartButton)

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
