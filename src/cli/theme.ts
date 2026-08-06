import { RGBA, SyntaxStyle } from "@opentui/core"
import type { ThemeName } from "../local/settings.js"

export type ThemeColors = {
  background: string
  surface: string
  userSurface: string
  codeSurface: string
  accent: string
  muted: string
  text: string
  cyan: string
  green: string
  orange: string
  pink: string
  yellow: string
  border: string
  diffAddedBg: string
  diffRemovedBg: string
  diffContextBg: string
  diffAddedContentBg: string
  diffRemovedContentBg: string
  diffContextContentBg: string
  diffLineNumberFg: string
}

const themes: Record<ThemeName, ThemeColors> = {
  default: {
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
    border: "#2A2A2A",
    diffAddedBg: "#1A2E22",
    diffRemovedBg: "#2E1A20",
    diffContextBg: "#1A1A1A",
    diffAddedContentBg: "#213D2B",
    diffRemovedContentBg: "#3D2228",
    diffContextContentBg: "#1A1A1A",
    diffLineNumberFg: "#565656",
  },
  nord: {
    background: "#252525",
    surface: "#343434",
    userSurface: "#303030",
    codeSurface: "#1E1E1E",
    accent: "#B8A1FF",
    muted: "#A0A0A0",
    text: "#F0F0F0",
    cyan: "#8DDBFF",
    green: "#B8F5D0",
    orange: "#FFD09A",
    pink: "#FFB0B8",
    yellow: "#FFE7A3",
    border: "#4A4A4A",
    diffAddedBg: "#263A2C",
    diffRemovedBg: "#402A2E",
    diffContextBg: "#252525",
    diffAddedContentBg: "#314B38",
    diffRemovedContentBg: "#503237",
    diffContextContentBg: "#252525",
    diffLineNumberFg: "#777777",
  },
  bright: {
    background: "#D8D8D6",
    surface: "#CECECA",
    userSurface: "#C9C5D5",
    codeSurface: "#C5C5C1",
    accent: "#44318D",
    muted: "#4F4A59",
    text: "#292532",
    cyan: "#334B7B",
    green: "#326247",
    orange: "#7A4900",
    pink: "#8D3151",
    yellow: "#654F00",
    border: "#A0A0A0",
    diffAddedBg: "#C2D8CC",
    diffRemovedBg: "#E0C8CD",
    diffContextBg: "#D8D8D6",
    diffAddedContentBg: "#ACCEB8",
    diffRemovedContentBg: "#D6ACB4",
    diffContextContentBg: "#D8D8D6",
    diffLineNumberFg: "#707070",
  },
  matrix: {
    background: "#0D0D0D",
    surface: "#1B1B1B",
    userSurface: "#141414",
    codeSurface: "#0A0A0A",
    accent: "#00FF66",
    muted: "#4D7A52",
    text: "#00FF41",
    cyan: "#5DFF8C",
    green: "#7DFFA0",
    orange: "#A8FFB8",
    pink: "#36E05A",
    yellow: "#B6FFCC",
    border: "#2A2A2A",
    diffAddedBg: "#102A18",
    diffRemovedBg: "#2A1414",
    diffContextBg: "#0D0D0D",
    diffAddedContentBg: "#163D20",
    diffRemovedContentBg: "#3D1818",
    diffContextContentBg: "#0D0D0D",
    diffLineNumberFg: "#4D7A52",
  },
}

export const colors: ThemeColors = { ...themes.default }

export function selectTheme(theme: ThemeName | undefined) {
  const previous = { ...colors }
  Object.assign(colors, themes[theme ?? "default"])
  return previous
}

export function createMarkdownStyle() {
  return SyntaxStyle.fromStyles({
    ...codeStyles(),
    "markup.heading.1": { fg: RGBA.fromHex(colors.accent), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(colors.accent), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(colors.accent), bold: true },
    "markup.italic": { fg: RGBA.fromHex(colors.accent), italic: true },
    "markup.list": { fg: RGBA.fromHex(colors.accent) },
    "markup.link": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.raw": { fg: RGBA.fromHex(colors.green) },
  })
}

export function createMutedMarkdownStyle() {
  const muted = { fg: RGBA.fromHex(colors.muted) }
  const mutedCode = Object.fromEntries(Object.keys(codeStyles()).map((name) => [name, muted]))
  return SyntaxStyle.fromStyles({
    ...mutedCode,
    "markup.heading.1": { ...muted, bold: true },
    "markup.heading.2": { ...muted, bold: true },
    "markup.heading.3": { ...muted, bold: true },
    "markup.italic": { ...muted, italic: true },
    "markup.link": { ...muted, underline: true },
    "markup.list": muted,
    "markup.raw": muted,
  })
}

export function createCodeSyntaxStyle() {
  return SyntaxStyle.fromStyles(codeStyles())
}

function codeStyles() {
  return {
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
}
