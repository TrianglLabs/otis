import { basename, extname, posix } from "node:path"
import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom"
import { readOfficeArchive } from "../inference/documents.js"
import type { Sheet, Workbook } from "./types.js"

/**
 * Spreadsheets and slide decks for Canvas, read from the Office Open XML packages Excel,
 * PowerPoint and the Python libraries that write them produce. A workbook becomes its cells; a
 * deck becomes HTML with every shape where the slide puts it, sized in container units so the
 * slide scales with its box.
 */

/** A sheet is cut here; the payload says so and the view shows what fits. */
export const MAX_SHEET_ROWS = 5000
export const MAX_SHEET_COLUMNS = 200
const MAX_SLIDES = 300
/** Pixels of EMU per inch and per point, the units Office measures in. */
const EMU_PER_PT = 12700
/** Excel's serial day 0, and the leap day 1900 never had that it still counts. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

export function parseDelimited(text: string, name: string): Workbook {
  const head = text.slice(0, text.indexOf("\n") + 1 || undefined)
  const delimiter = [",", "\t", ";"]
    .map((candidate) => [candidate, head.split(candidate).length] as const)
    .sort((left, right) => right[1] - left[1])[0][0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let truncated = false
  const endRow = () => {
    row.push(cell)
    cell = ""
    if (rows.length < MAX_SHEET_ROWS) rows.push(row.slice(0, MAX_SHEET_COLUMNS))
    truncated ||= rows.length >= MAX_SHEET_ROWS || row.length > MAX_SHEET_COLUMNS
    row = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else quoted = false
    } else if (char === '"' && cell === "") quoted = true
    else if (char === delimiter) {
      row.push(cell)
      cell = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1
      endRow()
    } else cell += char
  }
  if (cell !== "" || row.length > 0) endRow()
  return { sheets: [{ name: basename(name, extname(name)), rows }], truncated }
}

/** A workbook's cells as text, one line per row with tabs between cells, sheets titled. */
export function workbookText(workbook: Workbook) {
  return workbook.sheets
    .map((sheet) =>
      [
        workbook.sheets.length > 1 ? `## ${sheet.name}` : undefined,
        ...sheet.rows.map((row) => row.join("\t")),
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    )
    .join("\n\n")
}

export async function workbookFromXlsx(bytes: Buffer): Promise<Workbook> {
  const parts = await readOfficeArchive(
    bytes,
    "xl/workbook.xml",
    (name) => name.startsWith("xl/") && !name.startsWith("xl/theme/"),
  )
  const workbook = xml(parts, "xl/workbook.xml")
  const rels = relationships(parts, "xl/workbook.xml")
  const shared = [...elements(xml(parts, "xl/sharedStrings.xml"), "si")].map((item) =>
    [...descendants(item, "t")].map((node) => node.textContent ?? "").join(""),
  )
  const styles = xml(parts, "xl/styles.xml")
  const formats = new Map(
    [...elements(styles, "numFmt")].map((format) => [
      format.getAttribute("numFmtId") ?? "",
      format.getAttribute("formatCode") ?? "",
    ]),
  )
  const cellFormats = [...elements(styles, "cellXfs")]
    .flatMap((xfs) => children(xfs, "xf"))
    .map((xf) => numberFormat(xf.getAttribute("numFmtId") ?? "0", formats))
  let truncated = false
  const sheets: Sheet[] = []
  for (const sheet of elements(workbook, "sheet")) {
    const target = rels.get(sheet.getAttributeNS(RELS, "id") ?? "")
    const part = target && xml(parts, target)
    if (!part) continue
    const rows: string[][] = []
    for (const row of elements(part, "row")) {
      // Rows and cells name their place; an unnamed one follows the previous.
      const at = Number(row.getAttribute("r")) || rows.length + 1
      if (at > MAX_SHEET_ROWS) {
        truncated = true
        break
      }
      while (rows.length < at - 1) rows.push([])
      const cells: string[] = []
      for (const cell of children(row, "c")) {
        const reference = cell.getAttribute("r") ?? ""
        const column = columnIndex(reference.replace(/\d+$/, "")) ?? cells.length
        if (column >= MAX_SHEET_COLUMNS) {
          truncated = true
          break
        }
        while (cells.length < column) cells.push("")
        cells.push(cellText(cell, shared, cellFormats[Number(cell.getAttribute("s") ?? 0)]))
      }
      while (cells.at(-1) === "") cells.pop()
      rows.push(cells)
    }
    sheets.push({ name: sheet.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows })
  }
  if (sheets.length === 0) throw new Error("This workbook has no sheets.")
  return { sheets, truncated }
}

type NumberFormat = "general" | "percent" | "date" | "time" | "datetime"

/** Excel's built-in date and time formats by id, and what a custom code says it shows. */
function numberFormat(id: string, custom: Map<string, string>): NumberFormat {
  const code = custom.get(id)
  if (code === undefined) {
    const number = Number(id)
    if (number === 9 || number === 10) return "percent"
    if ((number >= 14 && number <= 17) || (number >= 27 && number <= 31) || number === 36)
      return "date"
    if ((number >= 18 && number <= 21) || (number >= 32 && number <= 35) || number >= 45)
      return number >= 50 && number <= 58 ? "datetime" : "time"
    return number === 22 ? "datetime" : "general"
  }
  // Colors, conditions and literal text carry letters that are not date codes.
  const bare = code.replace(/\[[^\]]*\]|"[^"]*"|\\./g, "")
  if (bare.includes("%")) return "percent"
  const date = /[yd]/i.test(bare) || /m{3,}/i.test(bare)
  const time = /[hs]/i.test(bare) || (/m/i.test(bare) && !date)
  return date && time ? "datetime" : date ? "date" : time ? "time" : "general"
}

function cellText(cell: XmlElement, shared: string[], format: NumberFormat = "general") {
  const type = cell.getAttribute("t")
  const formula = children(cell, "f")[0]?.textContent
  if (type === "inlineStr")
    return [...descendants(cell, "t")].map((node) => node.textContent ?? "").join("")
  const value = children(cell, "v")[0]?.textContent ?? ""
  if (type === "s") return shared[Number(value)] ?? ""
  if (type === "b") return value === "1" ? "TRUE" : "FALSE"
  // A formula whose result was never computed (a file no spreadsheet app has opened) shows as
  // the formula, as the app would before it recalculates.
  if (value === "") return formula ? `=${formula}` : ""
  if (type === "str" || type === "e") return value
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  if (format === "percent") return `${tidy(number * 100)}%`
  if (format === "general") return tidy(number)
  const date = new Date(EXCEL_EPOCH_MS + Math.round(number * 86_400_000))
  const day = date.toISOString().slice(0, 10)
  const clock = date.toISOString().slice(11, 19).replace(/:00$/, "")
  return format === "date" ? day : format === "time" ? clock : `${day} ${clock}`
}

/** Floating-point noise stripped the way a cell shows it. */
function tidy(number: number) {
  return String(Number(number.toPrecision(15)))
}

/** `A` is 0, `Z` 25, `AA` 26; undefined for anything that is not a column name. */
function columnIndex(letters: string) {
  if (!/^[A-Z]+$/.test(letters)) return undefined
  let index = 0
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64
  return index - 1
}

/** A deck as HTML the slides stylesheet lays out, and its words for excerpts and reading. */
export async function slidesFromPptx(bytes: Buffer) {
  const parts = await readOfficeArchive(
    bytes,
    "ppt/presentation.xml",
    (name) => name.startsWith("ppt/") && !name.startsWith("ppt/notesSlides/"),
  )
  const presentation = xml(parts, "ppt/presentation.xml")
  const size = first(presentation, "sldSz")
  const width = Number(size?.getAttribute("cx")) || 12_192_000
  const height = Number(size?.getAttribute("cy")) || 6_858_000
  const rels = relationships(parts, "ppt/presentation.xml")
  const html: string[] = []
  const text: string[] = []
  const ids = [...elements(presentation, "sldId")]
  if (ids.length > MAX_SLIDES)
    throw new Error(`This deck has ${ids.length} slides; the limit is ${MAX_SLIDES}.`)
  for (const [index, id] of ids.entries()) {
    const target = rels.get(id.getAttributeNS(RELS, "id") ?? "")
    const slide = target && xml(parts, target)
    if (!slide || !target) continue
    const layout = related(parts, target, "slideLayout")
    const master = layout && related(parts, layout.part, "slideMaster")
    const theme = master && related(parts, master.part, "theme")
    const deck: Deck = {
      parts,
      width,
      height,
      slide: { part: target, document: slide },
      layout,
      master,
      scheme: colorScheme(theme?.document, master?.document),
    }
    const words: string[] = []
    const body = [...shapes(deck, first(slide, "spTree"), words)].join("")
    const fill =
      [slide, layout?.document, master?.document]
        .map((document) => background(deck, document))
        .find((color) => color !== undefined) ?? "#ffffff"
    html.push(
      `<section class="slide"><div class="frame" style="aspect-ratio:${width}/${height};background:${fill}">${body}</div><span class="n">${index + 1}</span></section>`,
    )
    text.push(words.join("\n"))
  }
  if (html.length === 0) throw new Error("This deck has no slides.")
  return { html: html.join(""), text: text.join("\n\n") }
}

type Part = { part: string; document: XmlDocument }
type Deck = {
  parts: Map<string, Buffer>
  width: number
  height: number
  slide: Part
  layout: Part | undefined
  master: Part | undefined
  /** Theme colors by scheme name, with the master's map (bg1, tx1) already applied. */
  scheme: Map<string, string>
}
/** Where a shape sits, in EMU, before any group transform. */
type Box = { x: number; y: number; w: number; h: number }
const PLACEHOLDER_ALIASES: Record<string, string[]> = {
  ctrTitle: ["ctrTitle", "title"],
  title: ["title", "ctrTitle"],
  subTitle: ["subTitle", "body"],
  body: ["body", "obj"],
  obj: ["obj", "body"],
}

function* shapes(
  deck: Deck,
  tree: XmlElement | undefined,
  words: string[],
  transform: (box: Box) => Box = (box) => box,
): Generator<string> {
  for (const node of tree ? Array.from(tree.childNodes) : []) {
    const shape = node as XmlElement
    const name = shape.localName
    if (name === "grpSp") {
      const own = children(shape, "grpSpPr")[0]
      const frame = boxOf(own)
      const child = boxOf(own, "chOff", "chExt")
      // A group's children are drawn in its own coordinate space, mapped onto its frame.
      const map = (box: Box) =>
        frame && child?.w && child.h
          ? transform({
              x: frame.x + ((box.x - child.x) * frame.w) / child.w,
              y: frame.y + ((box.y - child.y) * frame.h) / child.h,
              w: (box.w * frame.w) / child.w,
              h: (box.h * frame.h) / child.h,
            })
          : transform(box)
      yield* shapes(deck, shape, words, map)
      continue
    }
    if (name !== "sp" && name !== "pic" && name !== "graphicFrame") continue
    const placeholder = first(shape, "ph")
    const inherited = placeholder ? inheritedPlaceholder(deck, placeholder) : []
    const properties = children(shape, name === "graphicFrame" ? "xfrm" : "spPr")[0]
    const box =
      boxOf(properties) ?? inherited.map((entry) => boxOf(children(entry, "spPr")[0])).find(Boolean)
    if (!box || box.w <= 0 || box.h <= 0) continue
    const placed = transform(box)
    const style = [
      `left:${percent(placed.x, deck.width)}`,
      `top:${percent(placed.y, deck.height)}`,
      `width:${percent(placed.w, deck.width)}`,
      `height:${percent(placed.h, deck.height)}`,
    ]
    const xfrm = properties && children(properties, "xfrm")[0]
    const rotation = Number(xfrm?.getAttribute("rot") ?? 0) / 60_000
    const flips = [xfrm?.getAttribute("flipH") === "1", xfrm?.getAttribute("flipV") === "1"]
    const transforms = [
      rotation ? `rotate(${rotation}deg)` : "",
      flips.some(Boolean) ? `scale(${flips[0] ? -1 : 1},${flips[1] ? -1 : 1})` : "",
    ].filter(Boolean)
    if (transforms.length) style.push(`transform:${transforms.join(" ")}`)
    if (name === "pic") {
      const image = picture(deck, shape)
      if (image) yield `<div class="shape" style="${style.join(";")}">${image}</div>`
      continue
    }
    if (name === "graphicFrame") {
      const table = first(shape, "tbl")
      const alt = children(shape, "nvGraphicFramePr")[0]
      const label = alt && children(alt, "cNvPr")[0]?.getAttribute("name")
      yield `<div class="shape" style="${style.join(";")}">${
        table
          ? tableHtml(deck, table, words)
          : `<div class="chart">${markup(label || "Chart")}</div>`
      }</div>`
      continue
    }
    const fill = properties && fillColor(deck, properties)
    if (fill) style.push(`background:${fill}`)
    const line = properties && children(properties, "ln")[0]
    const stroke = line && fillColor(deck, line)
    if (stroke)
      style.push(
        `border:${cqw(deck, Number(line.getAttribute("w") ?? EMU_PER_PT * 0.75))} solid ${stroke}`,
      )
    const geometry = properties && children(properties, "prstGeom")[0]?.getAttribute("prst")
    if (geometry === "ellipse") style.push("border-radius:50%")
    else if (geometry === "roundRect") style.push("border-radius:8%")
    const body = children(shape, "txBody")[0]
    yield `<div class="shape" style="${style.join(";")}">${
      body ? textBody(deck, body, inherited, placeholder, words) : ""
    }</div>`
  }
}

/** The layout's placeholder for a slide's, then the master's: by index, else by type. */
function inheritedPlaceholder(deck: Deck, placeholder: XmlElement) {
  const index = placeholder.getAttribute("idx")
  const type = placeholder.getAttribute("type") ?? "body"
  const types = PLACEHOLDER_ALIASES[type] ?? [type]
  return [deck.layout, deck.master].map((part) => {
    const candidates = [...elements(part?.document, "ph")].map((node) => ({
      node,
      shape: node.parentNode?.parentNode?.parentNode as XmlElement | undefined,
    }))
    const found =
      (index !== null && candidates.find(({ node }) => node.getAttribute("idx") === index)) ||
      candidates.find(({ node }) => types.includes(node.getAttribute("type") ?? "body"))
    return found?.shape
  })
}

/** A shape's frame from its transform, or a group's child space from `chOff` and `chExt`. */
function boxOf(
  properties: XmlElement | undefined,
  offset = "off",
  extent = "ext",
): Box | undefined {
  const xfrm = properties?.localName === "xfrm" ? properties : children(properties, "xfrm")[0]
  const at = children(xfrm, offset)[0]
  const size = children(xfrm, extent)[0]
  if (!at || !size) return undefined
  return {
    x: Number(at.getAttribute("x")),
    y: Number(at.getAttribute("y")),
    w: Number(size.getAttribute("cx")),
    h: Number(size.getAttribute("cy")),
  }
}

function picture(deck: Deck, shape: XmlElement) {
  const blip = first(shape, "blip")
  const target =
    blip && relationships(deck.parts, deck.slide.part).get(blip.getAttributeNS(RELS, "embed") ?? "")
  const bytes = target && deck.parts.get(target)
  const type =
    target &&
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    }[extname(target).toLowerCase()]
  if (!bytes || !type) return undefined
  const name = children(children(shape, "nvPicPr")[0], "cNvPr")[0]?.getAttribute("descr") ?? ""
  return `<img src="data:${type};base64,${bytes.toString("base64")}" alt="${markup(name)}">`
}

function tableHtml(deck: Deck, table: XmlElement, words: string[]) {
  const widths = children(children(table, "tblGrid")[0], "gridCol").map((column) =>
    Number(column.getAttribute("w")),
  )
  const total = widths.reduce((sum, width) => sum + width, 0) || 1
  const columns = widths
    .map((width) => `<col style="width:${((width / total) * 100).toFixed(2)}%">`)
    .join("")
  const rows = children(table, "tr")
    .map((row) => {
      const cells = children(row, "tc")
        .filter((cell) => !cell.getAttribute("hMerge") && !cell.getAttribute("vMerge"))
        .map((cell) => {
          const span = [cell.getAttribute("gridSpan"), cell.getAttribute("rowSpan")]
          const properties = children(cell, "tcPr")[0]
          const fill = properties && fillColor(deck, properties)
          const body = children(cell, "txBody")[0]
          return `<td${span[0] ? ` colspan="${Number(span[0])}"` : ""}${
            span[1] ? ` rowspan="${Number(span[1])}"` : ""
          }${fill ? ` style="background:${fill}"` : ""}>${
            body ? textBody(deck, body, [], undefined, words) : ""
          }</td>`
        })
        .join("")
      return `<tr>${cells}</tr>`
    })
    .join("")
  return `<table><colgroup>${columns}</colgroup><tbody>${rows}</tbody></table>`
}

/** A shape's text: paragraphs with the slide's own properties over what the deck hands down. */
function textBody(
  deck: Deck,
  body: XmlElement,
  inherited: (XmlElement | undefined)[],
  placeholder: XmlElement | undefined,
  words: string[],
) {
  const bodyProperties = children(body, "bodyPr")[0]
  const anchor = { t: "flex-start", ctr: "center", b: "flex-end" }[
    bodyProperties?.getAttribute("anchor") ?? ""
  ]
  const scale = Number(first(bodyProperties, "normAutofit")?.getAttribute("fontScale") ?? 100_000)
  const insets = ["lIns", "tIns", "rIns", "bIns"].map((name) =>
    cqw(deck, Number(bodyProperties?.getAttribute(name) ?? 91_440)),
  )
  const type = placeholder?.getAttribute("type") ?? (placeholder ? "body" : undefined)
  const category =
    type === "title" || type === "ctrTitle"
      ? "titleStyle"
      : placeholder
        ? "bodyStyle"
        : "otherStyle"
  // The chain a paragraph property is looked up along: this shape's list style, the layout and
  // master placeholders', then the master's styles for its kind of text.
  const styles = [
    children(body, "lstStyle")[0],
    ...inherited.map((shape) => children(children(shape, "txBody")[0], "lstStyle")[0]),
    children(first(deck.master?.document, "txStyles"), category)[0],
  ]
  const paragraphs = children(body, "p")
    .map((paragraph) => {
      const properties = children(paragraph, "pPr")[0]
      const level = Number(properties?.getAttribute("lvl") ?? 0)
      const levels = styles.map((style) => style && children(style, `lvl${level + 1}pPr`)[0])
      const lookup = (name: string) =>
        [properties, ...levels].map((node) => node && children(node, name)[0]).find(Boolean)
      const attribute = (name: string) =>
        [properties, ...levels].map((node) => node?.getAttribute(name)).find((v) => v != null)
      const runs = Array.from(paragraph.childNodes)
        .map((node) => node as XmlElement)
        .filter((node) => ["r", "br", "fld"].includes(node.localName ?? ""))
      const text = runs.map((run) => (run.localName === "br" ? "\n" : (run.textContent ?? "")))
      words.push(text.join(""))
      const defaults = [
        ...levels.map((level) => level && children(level, "defRPr")[0]),
        children(paragraph, "endParaRPr")[0],
      ]
      const style = [
        `text-align:${{ ctr: "center", r: "right", just: "justify" }[attribute("algn") ?? ""] ?? "left"}`,
      ]
      const marL = Number(attribute("marL") ?? 0)
      const indent = Number(attribute("indent") ?? 0)
      if (marL) style.push(`padding-left:${cqw(deck, marL)}`)
      if (indent) style.push(`text-indent:${cqw(deck, indent)}`)
      const before = lookup("spcBef")
      const after = lookup("spcAft")
      if (before) style.push(`margin-top:${spacing(deck, before)}`)
      if (after) style.push(`margin-bottom:${spacing(deck, after)}`)
      const lines = children(lookup("lnSpc"), "spcPct")[0]
      if (lines) style.push(`line-height:${(Number(lines.getAttribute("val")) / 100_000) * 1.2}`)
      const bullet =
        !lookup("buNone") &&
        (lookup("buChar")?.getAttribute("char") ?? (lookup("buAutoNum") && "•"))
      // An empty paragraph still takes a line at its own size.
      const content =
        runs.length === 0
          ? `<span style="font-size:${cqw(deck, size(defaults, scale, 1800))}">&nbsp;</span>`
          : runs
              .map((run) =>
                run.localName === "br"
                  ? "<br>"
                  : runHtml(deck, run, [children(run, "rPr")[0], ...defaults], scale),
              )
              .join("")
      // The bullet hangs in the indent, as wide as it, so wrapped lines start under the text.
      const hang = indent < 0 ? `width:${cqw(deck, -indent)}` : "margin-right:.3em"
      return `<p style="${style.join(";")}">${
        bullet && text.join("").trim()
          ? `<span class="bullet" style="font-size:${cqw(deck, size(defaults, scale, 1800))};${hang}">${markup(bullet)}</span>`
          : ""
      }${content}</p>`
    })
    .join("")
  return `<div class="text" style="padding:${insets[1]} ${insets[2]} ${insets[3]} ${insets[0]}${
    anchor ? `;justify-content:${anchor}` : ""
  }">${paragraphs}</div>`
}

/** Font size in EMU from the first run property naming one in hundredths of a point, autofit applied. */
function size(properties: (XmlElement | undefined)[], scale: number, fallback: number) {
  const declared = properties.map((node) => node?.getAttribute("sz")).find((v) => v != null)
  return ((Number(declared ?? fallback) * scale) / 100_000) * (EMU_PER_PT / 100)
}

function runHtml(
  deck: Deck,
  run: XmlElement,
  properties: (XmlElement | undefined)[],
  scale: number,
) {
  const attribute = (name: string) =>
    properties.map((node) => node?.getAttribute(name)).find((v) => v != null)
  const style = [`font-size:${cqw(deck, size(properties, scale, 1800))}`]
  const color = properties
    .map((node) => node && fillColor(deck, node))
    .find((value) => value !== undefined)
  if (color) style.push(`color:${color}`)
  if (attribute("b") === "1") style.push("font-weight:700")
  if (attribute("i") === "1") style.push("font-style:italic")
  const decorations = [
    attribute("u") && attribute("u") !== "none" ? "underline" : "",
    attribute("strike") && attribute("strike") !== "noStrike" ? "line-through" : "",
  ].filter(Boolean)
  if (decorations.length) style.push(`text-decoration:${decorations.join(" ")}`)
  const baseline = Number(attribute("baseline") ?? 0)
  if (baseline) style.push(`vertical-align:${baseline > 0 ? "super" : "sub"};font-size:smaller`)
  const typeface = properties
    .map((node) => children(node, "latin")[0]?.getAttribute("typeface"))
    .find((face) => face && !face.startsWith("+"))
  if (typeface) style.push(`font-family:${JSON.stringify(typeface)}`)
  const text = markup(run.textContent ?? "")
  const link = first(children(run, "rPr")[0], "hlinkClick")
  const href =
    link && relationships(deck.parts, deck.slide.part).get(link.getAttributeNS(RELS, "id") ?? "")
  const span = `<span style="${style.join(";")}">${text}</span>`
  return href && /^https?:\/\//i.test(href) ? `<a href="${markup(href)}">${span}</a>` : span
}

function spacing(deck: Deck, node: XmlElement) {
  const points = children(node, "spcPts")[0]
  if (points) return cqw(deck, Number(points.getAttribute("val")) * (EMU_PER_PT / 100))
  const percent = children(node, "spcPct")[0]
  return `${((Number(percent?.getAttribute("val") ?? 0) / 100_000) * 1.2).toFixed(3)}em`
}

/** The slide's background color: its own, a referenced one, or none to try the next document. */
function background(deck: Deck, document: XmlDocument | undefined) {
  const node = first(document, "bg")
  if (!node) return undefined
  const properties = children(node, "bgPr")[0]
  if (properties) return fillColor(deck, properties) ?? undefined
  const reference = children(node, "bgRef")[0]
  return reference ? color(deck, reference) : undefined
}

/** A solid fill, or a gradient's first stop; undefined for none, so the caller keeps looking. */
function fillColor(deck: Deck, properties: XmlElement) {
  for (const node of Array.from(properties.childNodes) as XmlElement[]) {
    if (node.localName === "solidFill") return color(deck, node)
    if (node.localName === "gradFill") {
      const stop = first(node, "gs")
      return stop ? color(deck, stop) : undefined
    }
    if (node.localName === "noFill") return undefined
  }
  return undefined
}

/** A color element's child as CSS, with the theme's scheme and any luminance adjustments. */
function color(deck: Deck, parent: XmlElement) {
  for (const node of Array.from(parent.childNodes) as XmlElement[]) {
    let base: string | undefined
    if (node.localName === "srgbClr") base = `#${node.getAttribute("val")}`
    else if (node.localName === "sysClr") base = `#${node.getAttribute("lastClr") ?? "000000"}`
    else if (node.localName === "schemeClr") base = deck.scheme.get(node.getAttribute("val") ?? "")
    else if (node.localName === "prstClr") base = node.getAttribute("val") ?? undefined
    if (!base) continue
    const changes = children(node)
    const rgb = changes.length ? parseColor(base) : undefined
    if (!rgb) return base
    let [h, s, l] = rgbToHsl(rgb)
    let alpha = 1
    for (const change of changes) {
      const value = Number(change.getAttribute("val")) / 100_000
      if (change.localName === "lumMod") l *= value
      else if (change.localName === "lumOff") l += value
      else if (change.localName === "tint") l = 1 - (1 - l) * value
      else if (change.localName === "shade") l *= value
      else if (change.localName === "alpha") alpha = value
    }
    l = Math.min(1, Math.max(0, l))
    return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%${
      alpha < 1 ? ` / ${alpha.toFixed(2)}` : ""
    })`
  }
  return undefined
}

/** Theme colors by scheme name and by the master's aliases for them (bg1 is usually lt1). */
function colorScheme(theme: XmlDocument | undefined, master: XmlDocument | undefined) {
  const scheme = new Map<string, string>()
  for (const node of children(first(theme, "clrScheme"))) {
    const value =
      children(node, "srgbClr")[0]?.getAttribute("val") ??
      children(node, "sysClr")[0]?.getAttribute("lastClr")
    if (node.localName && value) scheme.set(node.localName, `#${value}`)
  }
  const map = first(master, "clrMap")
  for (const alias of ["bg1", "tx1", "bg2", "tx2"]) {
    const target = map?.getAttribute(alias) ?? (alias.startsWith("bg") ? "lt" : "dk") + alias.at(-1)
    const value = scheme.get(target)
    if (value) scheme.set(alias, value)
  }
  return scheme
}

function parseColor(value: string): [number, number, number] | undefined {
  const match = /^#([\da-f]{6})$/i.exec(value)
  if (!match) return undefined
  const number = Number.parseInt(match[1], 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === red
      ? ((green - blue) / d + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / d + 2) * 60
        : ((red - green) / d + 4) * 60
  return [h, s, l]
}

/** EMU as a share of the slide's width, so sizes follow the slide's box. */
function cqw(deck: Deck, emu: number) {
  return `${((emu / deck.width) * 100).toFixed(3)}cqw`
}

function percent(emu: number, whole: number) {
  return `${((emu / whole) * 100).toFixed(3)}%`
}

/** The part a document's relationship of `type` points at, parsed. */
function related(parts: Map<string, Buffer>, part: string, type: string): Part | undefined {
  const rels = relationships(parts, part, type)
  const target = [...rels.values()][0]
  const document = target && xml(parts, target)
  return target && document ? { part: target, document } : undefined
}

/** A part's relationships by id, as package paths; `type` keeps only one relationship type. */
function relationships(parts: Map<string, Buffer>, part: string, type?: string) {
  const directory = posix.dirname(part)
  const document = xml(parts, posix.join(directory, "_rels", `${posix.basename(part)}.rels`))
  const map = new Map<string, string>()
  for (const relationship of elements(document, "Relationship")) {
    const target = relationship.getAttribute("Target") ?? ""
    const kind = relationship.getAttribute("Type") ?? ""
    if (type && !kind.endsWith(`/${type}`)) continue
    if (relationship.getAttribute("TargetMode") === "External")
      map.set(relationship.getAttribute("Id") ?? "", target)
    else
      map.set(
        relationship.getAttribute("Id") ?? "",
        target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(directory, target)),
      )
  }
  return map
}

function xml(parts: Map<string, Buffer>, name: string) {
  const bytes = parts.get(name)
  if (!bytes) return undefined
  const text = bytes.toString("utf8")
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error(`${name} declares a document type, which Office packages never do.`)
  return new DOMParser({
    locator: false,
    onError: (_level, message) => {
      throw new Error(`Could not parse ${name}: ${message}`)
    },
  }).parseFromString(text, "application/xml")
}

/** Every element with this local name anywhere in the document, in document order. */
function* elements(document: XmlDocument | undefined, name: string) {
  if (document?.documentElement) yield* descendants(document.documentElement, name)
}

/** The first element with this local name in a document or under a node, if any. */
function first(scope: XmlDocument | XmlElement | undefined, name: string): XmlElement | undefined {
  const found = (
    scope && "documentElement" in scope ? elements(scope, name) : descendants(scope, name)
  ).next()
  return found.done ? undefined : found.value
}

function* descendants(node: XmlElement | undefined, name: string): Generator<XmlElement> {
  for (const child of node ? (Array.from(node.childNodes) as XmlElement[]) : []) {
    if (child.nodeType !== 1) continue
    if (child.localName === name) yield child
    yield* descendants(child, name)
  }
}

/** Direct element children, by local name when given. */
function children(node: XmlElement | undefined, name?: string) {
  return node
    ? (Array.from(node.childNodes) as XmlElement[]).filter(
        (child) => child.nodeType === 1 && (!name || child.localName === name),
      )
    : []
}

function markup(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
