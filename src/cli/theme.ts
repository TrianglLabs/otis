import { RGBA, SyntaxStyle } from "@opentui/core"

export const colors = {
  background: "#1A1A1A",
  surface: "#262626",
  userSurface: "#1C1A2E",
  codeSurface: "#151515",
  accent: "#8B7CFF",
  muted: "#808080",
  text: "#D8DEE9",
  cyan: "#7DD3FC",
  green: "#A7F3D0",
  orange: "#FDBA74",
  pink: "#FDA4AF",
  yellow: "#FDE68A",
  diffAddedBg: "#1A2E22",
  diffRemovedBg: "#2E1A20",
  diffContextBg: "#1A1A1A",
  diffAddedContentBg: "#213D2B",
  diffRemovedContentBg: "#3D2228",
  diffContextContentBg: "#1A1A1A",
  diffLineNumberFg: "#565656",
}

const codeStyles = {
  default: { fg: RGBA.fromHex(colors.text) },
  attribute: { fg: RGBA.fromHex(colors.cyan) },
  boolean: { fg: RGBA.fromHex(colors.orange), bold: true },
  comment: { fg: RGBA.fromHex(colors.muted), italic: true },
  constant: { fg: RGBA.fromHex(colors.orange) },
  constructor: { fg: RGBA.fromHex(colors.yellow) },
  embedded: { fg: RGBA.fromHex(colors.text) },
  function: { fg: RGBA.fromHex(colors.cyan), bold: true },
  keyword: { fg: RGBA.fromHex(colors.accent), bold: true },
  number: { fg: RGBA.fromHex(colors.orange) },
  operator: { fg: RGBA.fromHex(colors.pink) },
  property: { fg: RGBA.fromHex(colors.cyan) },
  punctuation: { fg: RGBA.fromHex(colors.muted) },
  string: { fg: RGBA.fromHex(colors.green) },
  tag: { fg: RGBA.fromHex(colors.pink) },
  type: { fg: RGBA.fromHex(colors.yellow) },
  variable: { fg: RGBA.fromHex(colors.text) },
  "variable.builtin": { fg: RGBA.fromHex(colors.orange) },
}

export const markdownStyle = SyntaxStyle.fromStyles({
  ...codeStyles,
  "markup.heading.1": { fg: RGBA.fromHex(colors.accent), bold: true },
  "markup.heading.2": { fg: RGBA.fromHex(colors.accent), bold: true },
  "markup.heading.3": { fg: RGBA.fromHex(colors.accent), bold: true },
  "markup.italic": { fg: RGBA.fromHex(colors.accent), italic: true },
  "markup.list": { fg: RGBA.fromHex(colors.accent) },
  "markup.link": { fg: RGBA.fromHex(colors.cyan), underline: true },
  "markup.raw": { fg: RGBA.fromHex(colors.green) },
})

export const codeSyntaxStyle = SyntaxStyle.fromStyles(codeStyles)
