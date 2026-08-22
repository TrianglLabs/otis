import { BoxRenderable, TextRenderable } from "@opentui/core"
import { colors } from "../theme.js"
import { colorPulseAmount, selectionOutline } from "./color-pulse.js"
import type { Renderer } from "./types.js"

export type PickerRow = {
  box: BoxRenderable
  title: TextRenderable
  meta: TextRenderable
  bg: string
  outline: boolean
}

export type PickerRowSpec = {
  title: string
  meta?: string
  fg: string
  selected: boolean
}

export type PickerRowOptions = {
  bg?: string
  outline?: boolean
}

export function pickerRowBoxId(id: string) {
  return `${id}-box`
}

export function truncatePickerLabel(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export function createPickerRow(renderer: Renderer, id: string, options: PickerRowOptions = {}): PickerRow {
  const bg = options.bg ?? colors.surface
  const outline = options.outline === true
  const box = new BoxRenderable(renderer, {
    id: pickerRowBoxId(id),
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    backgroundColor: bg,
    paddingX: 0,
    paddingY: 0,
    ...(outline
      ? {
          border: true,
          borderStyle: "rounded" as const,
          borderColor: bg,
        }
      : {}),
  })
  const title = new TextRenderable(renderer, {
    id,
    content: "",
    fg: colors.text,
    bg,
    selectable: false,
    truncate: true,
  })
  const meta = new TextRenderable(renderer, {
    id: `${id}-meta`,
    content: "",
    fg: colors.muted,
    bg,
    selectable: false,
    truncate: true,
    visible: false,
  })
  box.add(title)
  box.add(meta)
  return { box, title, meta, bg, outline }
}

export function stylePickerRow(row: PickerRow, spec: PickerRowSpec, elapsedMs = 0) {
  row.title.content = `${spec.selected ? "›" : " "} ${spec.title}`
  row.title.fg = spec.selected ? colors.accent : spec.fg
  row.title.bg = row.bg
  row.meta.content = spec.meta ? `  ${spec.meta}` : ""
  row.meta.fg = colors.muted
  row.meta.bg = row.bg
  row.meta.visible = Boolean(spec.meta)
  row.box.backgroundColor = row.bg
  if (row.outline) paintPickerOutline(row, spec.selected, elapsedMs)
}

export function paintPickerOutline(row: PickerRow, selected: boolean, elapsedMs: number) {
  // Color only — toggling `border` after init makes OpenTUI re-enable it and
  // jumps the row size. Outlined rows keep a reserved rounded frame.
  row.box.borderColor = selected ? selectionOutline(colorPulseAmount(elapsedMs)) : row.bg
}
