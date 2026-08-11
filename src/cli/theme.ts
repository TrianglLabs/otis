import { type MarkdownTableOptions, RGBA, SyntaxStyle } from "@opentui/core"
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
    border: "#444444",
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
    userSurface: "#322E42",
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
  midnight: {
    background: "#0B1020",
    surface: "#111827",
    userSurface: "#18142D",
    codeSurface: "#070B14",
    accent: "#A78BFA",
    muted: "#7C879E",
    text: "#E5E7EB",
    cyan: "#67E8F9",
    green: "#6EE7B7",
    orange: "#FDBA74",
    pink: "#F9A8D4",
    yellow: "#FDE68A",
    border: "#334155",
    diffAddedBg: "#0D2A24",
    diffRemovedBg: "#2A1421",
    diffContextBg: "#0B1020",
    diffAddedContentBg: "#124235",
    diffRemovedContentBg: "#421C2E",
    diffContextContentBg: "#0B1020",
    diffLineNumberFg: "#526078",
  },
  graphite: {
    background: "#09090B",
    surface: "#111113",
    userSurface: "#1A1A1E",
    codeSurface: "#050506",
    accent: "#E4E4E7",
    muted: "#92929B",
    text: "#E7E7EA",
    cyan: "#A5D8E8",
    green: "#A7D7B5",
    orange: "#D6B07A",
    pink: "#D6A1B8",
    yellow: "#D8C894",
    border: "#45454B",
    diffAddedBg: "#132019",
    diffRemovedBg: "#241518",
    diffContextBg: "#09090B",
    diffAddedContentBg: "#1A3022",
    diffRemovedContentBg: "#381D23",
    diffContextContentBg: "#09090B",
    diffLineNumberFg: "#66666F",
  },
  // Retro 70s beige: warm cream surfaces, sepia accent, and an earth-tone
  // syntax palette (avocado, harvest gold, burnt orange, dusty rose).
  beige: {
    background: "#EAE3CE",
    surface: "#DDD3B6",
    userSurface: "#DCC79A",
    codeSurface: "#CFC4A6",
    accent: "#8A4B1F",
    muted: "#8A7A5C",
    text: "#33291D",
    cyan: "#3F6E66",
    green: "#667B2F",
    orange: "#A05E10",
    pink: "#9E4F5E",
    yellow: "#8A6D1F",
    border: "#B9AA85",
    diffAddedBg: "#CDD8AC",
    diffRemovedBg: "#E3C4B4",
    diffContextBg: "#EAE3CE",
    diffAddedContentBg: "#BFCB96",
    diffRemovedContentBg: "#D8B09E",
    diffContextContentBg: "#EAE3CE",
    diffLineNumberFg: "#A89A76",
  },
  // Neon-soaked 80s Miami: deep purple night, hot pink and cyan neon.
  vice: {
    background: "#1B1035",
    surface: "#2A1B4A",
    userSurface: "#3D1B4E",
    codeSurface: "#150C28",
    accent: "#FF6EC7",
    muted: "#8F7FB8",
    text: "#EDE6F7",
    cyan: "#4DD8E8",
    green: "#7BF1A8",
    orange: "#FFB86B",
    pink: "#FF7EB6",
    yellow: "#FFE873",
    border: "#4A3670",
    diffAddedBg: "#1F3D33",
    diffRemovedBg: "#4A1E3D",
    diffContextBg: "#1B1035",
    diffAddedContentBg: "#2A4A3A",
    diffRemovedContentBg: "#5C284C",
    diffContextContentBg: "#1B1035",
    diffLineNumberFg: "#6B5A94",
  },
  // Retro corporate teal-phosphor terminal. Background, foreground, and the
  // syntax palette are taken from the on-screen MDR software: BG #010A13,
  // FG #ABFFE9, and the four bin colors WO #05C3A8 / FC #1EEFFF / DR #DF81D5 /
  // MA #F9ECBB.
  eagan: {
    background: "#010A13",
    surface: "#0A1E28",
    userSurface: "#0D2B33",
    codeSurface: "#01060C",
    accent: "#1EEFFF",
    muted: "#4E7E7C",
    text: "#ABFFE9",
    cyan: "#05C3A8",
    green: "#8FE3B4",
    orange: "#F0A868",
    pink: "#DF81D5",
    yellow: "#F9ECBB",
    border: "#1A464A",
    diffAddedBg: "#0B2E24",
    diffRemovedBg: "#2E1524",
    diffContextBg: "#010A13",
    diffAddedContentBg: "#123B2E",
    diffRemovedContentBg: "#3D1C30",
    diffContextContentBg: "#010A13",
    diffLineNumberFg: "#2E5E58",
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

export function createMarkdownTableOptions(): MarkdownTableOptions {
  return {
    style: "grid",
    widthMode: "full",
    columnFitter: "proportional",
    wrapMode: "word",
    cellPaddingX: 1,
    cellPaddingY: 0,
    borders: true,
    outerBorder: true,
    borderStyle: "rounded",
    borderColor: colors.border,
    selectable: true,
  }
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
