import { describe, expect, it } from "vitest"
import { officeText, payloadFromBytes } from "../../src/artifacts/files.js"
import {
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  parseDelimited,
  slidesFromPptx,
  workbookFromXlsx,
  workbookText,
} from "../../src/artifacts/office.js"
import { minimalDocx, minimalPptx, minimalXlsx } from "../inference/support/document-fixtures.js"

describe("delimited text", () => {
  it("reads quoted cells, embedded delimiters and newlines, and names the sheet after the file", () => {
    const text = 'name,note\n"Smith, Jane","Says ""hi""\nand bye"\nplain,\r\n'
    expect(parseDelimited(text, "people.csv")).toEqual({
      sheets: [
        {
          name: "people",
          rows: [
            ["name", "note"],
            ["Smith, Jane", 'Says "hi"\nand bye'],
            ["plain", ""],
          ],
        },
      ],
      truncated: false,
    })
  })

  it("picks the delimiter the first line uses most: tabs and semicolons too", () => {
    expect(parseDelimited("a\tb\tc,d\n1\t2\t3,4", "x.tsv").sheets[0].rows).toEqual([
      ["a", "b", "c,d"],
      ["1", "2", "3,4"],
    ])
    expect(parseDelimited("a;b\n1;2", "x.csv").sheets[0].rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("cuts a sheet at the row and column caps and says so", () => {
    const wide = Array.from({ length: MAX_SHEET_COLUMNS + 1 }, (_, i) => String(i)).join(",")
    const tall = Array.from({ length: MAX_SHEET_ROWS + 2 }, () => "x").join("\n")
    const columns = parseDelimited(wide, "wide.csv")
    expect(columns.sheets[0].rows[0]).toHaveLength(MAX_SHEET_COLUMNS)
    expect(columns.truncated).toBe(true)
    const rows = parseDelimited(tall, "tall.csv")
    expect(rows.sheets[0].rows).toHaveLength(MAX_SHEET_ROWS)
    expect(rows.truncated).toBe(true)
    expect(parseDelimited("a,b\n1,2", "ok.csv").truncated).toBe(false)
  })
})

describe("Excel workbooks", () => {
  it("reads sheets in order: shared, inline and formula strings, numbers, dates, percents, booleans, and an uncomputed formula as itself", async () => {
    const workbook = await workbookFromXlsx(await minimalXlsx())
    expect(workbook.truncated).toBe(false)
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Budget", "Flights"])
    expect(workbook.sheets[0].rows).toEqual([
      ["Item", "Cost", "When"],
      [],
      ["Hotel & taxes", "1234.5", "2025-10-01", "12.5%", "TRUE", "12:00", "=B3*C3"],
    ])
    expect(workbook.sheets[1].rows).toEqual([["0.1", "0.2"]])
  })

  it("flattens to tab-separated lines with sheet headings, for reading and excerpts", async () => {
    const bytes = await minimalXlsx()
    const text = workbookText(await workbookFromXlsx(bytes))
    expect(text).toBe(
      "## Budget\nItem\tCost\tWhen\n\nHotel & taxes\t1234.5\t2025-10-01\t12.5%\tTRUE\t12:00\t=B3*C3\n\n## Flights\n0.1\t0.2",
    )
    expect(await officeText(bytes, "xlsx", "budget.xlsx")).toBe(text)
  })

  it("refuses a package that is not a workbook", async () => {
    await expect(workbookFromXlsx(Buffer.from(await minimalDocx("x")))).rejects.toThrow(
      "not a valid XLSX file",
    )
  })
})

describe("PowerPoint decks", () => {
  it("places every shape on its slide, inheriting positions, sizes, bullets and colors from the layout, master and theme", async () => {
    const { html, text } = await slidesFromPptx(await minimalPptx())
    const slides = html.split('<section class="slide"').slice(1)
    expect(slides).toHaveLength(2)
    expect(slides[0]).toContain(
      '<div class="frame" style="aspect-ratio:12192000/6858000;background:#FFFFFF">',
    )
    // The second slide paints its own background.
    expect(slides[1]).toContain("background:#112233")
    // The title has no position of its own: the layout's placeholder lends it one, the master's
    // title style its size and color (tx2 maps to dk2).
    expect(slides[0]).toContain("left:5.000%;top:6.667%;width:90.000%;height:16.667%")
    expect(slides[0]).toMatch(/font-size:4\.583cqw;color:#1F3864;font-weight:700[^>]*>Trip plan 1</)
    // Body text: a bullet from the master's body style, autofit halving the size, and the
    // second paragraph opting out of bullets while linking out.
    expect(slides[0]).toContain('<span class="bullet"')
    expect(slides[0]).toContain("font-size:1.458cqw")
    expect(slides[0]).toMatch(
      /<a href="https:\/\/example\.com\/hotel"><span[^>]*font-weight:700[^>]*>Hotel link<\/span><\/a>/,
    )
    expect(slides[0].split('<span class="bullet"')).toHaveLength(2)
    // A rotated ellipse with a darkened theme accent, a picture as a data URL, and a table.
    expect(slides[0]).toContain(
      "transform:rotate(45deg);background:hsl(218 52% 26%);border-radius:50%",
    )
    expect(slides[0]).toContain('<img src="data:image/png;base64,iVBOR')
    expect(slides[0]).toContain('alt="Beach"')
    expect(slides[0]).toContain('<col style="width:66.67%">')
    expect(slides[0]).toContain(">$640</span>")
    expect(slides[0]).toContain('<span class="n">1</span>')
    expect(text).toBe(
      "Trip plan 1\nFly Saturday\nHotel link\nDraft\nFlights\n$640\n\nTrip plan 2\nFly Saturday\nHotel link\nDraft\nFlights\n$640",
    )
  })

  it("refuses a package that is not a deck", async () => {
    await expect(slidesFromPptx(await minimalXlsx())).rejects.toThrow("not a valid PPTX file")
  })
})

describe("Office payloads", () => {
  const metadata = (kind: "csv" | "xlsx" | "pptx", title: string) => ({
    id: `workspace:${title}`,
    revision: 1,
    source: "workspace" as const,
    kind,
    title,
    mimeType: "",
    editable: false,
  })

  it("carries sheets for CSV and Excel and HTML for decks", async () => {
    const csv = await payloadFromBytes(Buffer.from("a,b\n1,2"), metadata("csv", "t.csv"), "t.csv")
    expect(csv).toMatchObject({
      encoding: "sheets",
      content: {
        sheets: [
          {
            name: "t",
            rows: [
              ["a", "b"],
              ["1", "2"],
            ],
          },
        ],
        truncated: false,
      },
    })
    const xlsx = await payloadFromBytes(await minimalXlsx(), metadata("xlsx", "b.xlsx"), "b.xlsx")
    expect(xlsx).toMatchObject({ encoding: "sheets" })
    const pptx = await payloadFromBytes(await minimalPptx(), metadata("pptx", "d.pptx"), "d.pptx")
    expect(pptx).toMatchObject({ encoding: "html" })
    expect((pptx.content as string).startsWith('<section class="slide"')).toBe(true)
    await expect(
      payloadFromBytes(Buffer.from("plain"), metadata("pptx", "d.pptx"), "d.pptx"),
    ).rejects.toThrow("d.pptx is not a PPTX file.")
  })
})
