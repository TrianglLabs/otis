import { BoxRenderable, InputRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

export function createChatInput(renderer: Renderer, label: string) {
  const input = new TextareaRenderable(renderer, {
    id: "otis-input",
    placeholder: "",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 1,
    minHeight: 1,
    maxHeight: 10,
    wrapMode: "word",
    scrollMargin: 0,
    textColor: colors.text,
    cursorColor: colors.accent,
    backgroundColor: colors.background,
    focusedBackgroundColor: colors.background,
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
    flexShrink: 0,
    fg: colors.muted,
    bg: colors.background,
    selectable: false,
  })
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    flexDirection: "row",
    width: "100%",
    maxWidth: undefined,
    minWidth: 24,
    flexShrink: 0,
    backgroundColor: colors.background,
    border: true,
    borderStyle: "rounded",
    borderColor: "#2A2A2A",
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
      id: "setup-button",
      content: "  Set up Otis  ",
      fg: colors.background,
      bg: colors.accent,
      selectable: false,
    }),
  )
  setupButtonBox.add(
    new TextRenderable(renderer, {
      id: "setup-hint",
      content: "Fireworks runs the model · Parallel provides web access",
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
  })
  const setupInputLabel = new TextRenderable(renderer, {
    id: "setup-input-label",
    content: "API key",
    fg: colors.accent,
    selectable: false,
  })
  const setupMessage = new TextRenderable(renderer, {
    id: "setup-message",
    content: " ",
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
    borderColor: "#2A2A2A",
    paddingX: 1,
    paddingY: 0,
    gap: 1,
  })
  setupInputBox.add(setupInputLabel)
  setupInputBox.add(setupInput)

  const setupForm = new BoxRenderable(renderer, {
    id: "setup-form",
    flexDirection: "column",
    width: "100%",
    minWidth: 24,
    flexShrink: 0,
    backgroundColor: colors.background,
    gap: 1,
  })
  setupForm.add(setupInputBox)
  setupForm.add(setupMessage)

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
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
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
