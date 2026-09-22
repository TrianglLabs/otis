import {
  BoxRenderable,
  fg,
  type ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  t,
} from "@opentui/core"
import { colors } from "../theme.js"
import { colorPulseAmount, selectionOutline, shimmerText } from "./color-pulse.js"
import type { Renderer } from "./types.js"

type PickerRowBg = "background" | "surface"

export type PickerRow = {
  box: BoxRenderable
  title: TextRenderable
  meta: TextRenderable
  bg: PickerRowBg
  outline: boolean
}

export type PickerRowSpec = {
  title: string
  suffixes?: Array<{ text: string; fg?: string; shimmer?: boolean }>
  meta?: string
  fg: string
  selected: boolean
  header?: boolean
  disabled?: boolean
}

type PickerRowOptions = {
  bg?: PickerRowBg
  outline?: boolean
}

export function pickerRowBoxId(id: string) {
  return `${id}-box`
}

export function truncatePickerLabel(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export function createPickerRow(
  renderer: Renderer,
  id: string,
  options: PickerRowOptions = {},
): PickerRow {
  const bg = options.bg ?? "surface"
  const fill = colors[bg]
  const outline = options.outline === true
  const box = new BoxRenderable(renderer, {
    id: pickerRowBoxId(id),
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    backgroundColor: fill,
    paddingX: 0,
    paddingY: 0,
    ...(outline ? { border: true, borderStyle: "rounded" as const, borderColor: fill } : {}),
  })
  const title = new TextRenderable(renderer, {
    id,
    content: "",
    fg: colors.text,
    bg: fill,
    selectable: false,
    truncate: true,
  })
  const meta = new TextRenderable(renderer, {
    id: `${id}-meta`,
    content: "",
    fg: colors.muted,
    bg: fill,
    selectable: false,
    truncate: true,
    visible: false,
  })
  box.add(title)
  box.add(meta)
  return { box, title, meta, bg, outline }
}

/**
 * Grows or shrinks `rows` to match `specs`, creating rows as `${idPrefix}-${index}` and restyling
 * all of them.
 */
export function syncPickerRows(
  renderer: Renderer,
  container: BoxRenderable | ScrollBoxRenderable,
  rows: PickerRow[],
  specs: readonly PickerRowSpec[],
  idPrefix: string,
  options: (spec: PickerRowSpec) => PickerRowOptions,
  elapsedMs = 0,
) {
  while (rows.length > specs.length) container.remove((rows.pop() as PickerRow).box.id)
  specs.forEach((spec, index) => {
    const existing = rows[index]
    if (existing) {
      stylePickerRow(existing, spec, elapsedMs)
      return
    }
    const row = createPickerRow(renderer, `${idPrefix}-${index}`, options(spec))
    stylePickerRow(row, spec, elapsedMs)
    rows.push(row)
    container.add(row.box)
  })
}

export function stylePickerRow(row: PickerRow, spec: PickerRowSpec, elapsedMs = 0) {
  const fill = colors[row.bg]
  const prefix = spec.header ? "" : spec.selected ? "›" : " "
  const title = spec.header ? spec.title : `${prefix} ${spec.title}`
  row.title.content = spec.suffixes?.length
    ? titleWithSuffixes(title, spec.suffixes, elapsedMs)
    : title
  row.title.fg = spec.selected && !spec.disabled && !spec.header ? colors.accent : spec.fg
  row.title.bg = fill
  row.meta.content = spec.meta ? `  ${spec.meta}` : ""
  row.meta.fg = colors.muted
  row.meta.bg = fill
  row.meta.visible = Boolean(spec.meta)
  row.box.backgroundColor = fill
  if (row.outline) paintPickerOutline(row, spec.selected && !spec.header, elapsedMs)
}

export function paintPickerOutline(row: PickerRow, selected: boolean, elapsedMs: number) {
  // Color only — toggling `border` after init makes OpenTUI re-enable it and
  // jumps the row size. Outlined rows keep a reserved rounded frame.
  row.box.borderColor = selected ? selectionOutline(colorPulseAmount(elapsedMs)) : colors[row.bg]
}

function titleWithSuffixes(
  title: string,
  suffixes: NonNullable<PickerRowSpec["suffixes"]>,
  elapsedMs: number,
) {
  const chunks = [...t`${title}`.chunks]
  for (const suffix of suffixes) {
    chunks.push(...t`  `.chunks)
    if (suffix.shimmer) chunks.push(...shimmerText(suffix.text, elapsedMs).chunks)
    else if (suffix.fg) chunks.push(...t`${fg(suffix.fg)(suffix.text)}`.chunks)
    else chunks.push(...t`${suffix.text}`.chunks)
  }
  return new StyledText(chunks)
}
