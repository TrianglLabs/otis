import { type RGBA, rgbToHex, ScrollBoxRenderable } from "@opentui/core"
import { colors, type ThemeColors } from "../theme.js"

const RECOLOR_KEYS = ["backgroundColor", "borderColor", "fg", "bg", "textColor", "cursorColor"] as const

type RecolorNode = {
  getChildren?: () => unknown[]
  wrapper?: RecolorNode
  viewport?: RecolorNode
  content?: RecolorNode
} & Record<string, unknown>

export function recolorTree(renderables: Iterable<{ getChildren(): unknown[] }>, previous: ThemeColors) {
  const replacements = new Map<string, string>()
  const visited = new WeakSet<object>()
  for (const key of Object.keys(previous) as (keyof ThemeColors)[]) {
    const oldHex = previous[key].toLowerCase()
    const newHex = colors[key]
    if (oldHex !== newHex.toLowerCase()) replacements.set(oldHex, newHex)
  }

  const visit = (current: RecolorNode | undefined) => {
    if (!current || visited.has(current)) return
    visited.add(current)
    for (const key of RECOLOR_KEYS) {
      const value = current[key]
      if (isColor(value)) {
        const replacement = replacements.get(rgbToHex(value).toLowerCase())
        if (replacement) current[key] = replacement
      } else if (typeof value === "string") {
        const replacement = replacements.get(value.toLowerCase())
        if (replacement && replacement.toLowerCase() !== value.toLowerCase()) current[key] = replacement
      }
    }
    if (current instanceof ScrollBoxRenderable) {
      visit(current.wrapper)
      visit(current.viewport)
      visit(current.content)
    }
    for (const child of current.getChildren?.() ?? []) visit(child as RecolorNode)
  }
  for (const renderable of renderables) visit(renderable as RecolorNode)
}

function isColor(value: unknown): value is RGBA {
  return typeof value === "object" && value !== null && "toInts" in value && typeof value.toInts === "function"
}
