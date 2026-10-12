import JSZip from "jszip"

export async function minimalDocx(text: string) {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  )
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  )
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

export function minimalPdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${escapePdf(text)}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, "latin1"))
}

function escapePdf(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function setZipEntrySize(bytes: Uint8Array, target: string, size: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name !== target) continue
    view.setUint32(offset + 24, size, true)
    return
  }
  throw new Error(`Missing ZIP entry: ${target}`)
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const DRAWING = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const PRESENTATION =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  `${DRAWING} xmlns:r="${REL}"`

function relationships(entries: [string, string, string][]) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}">` +
    entries
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
      )
      .join("") +
    "</Relationships>"
  )
}

/**
 * A workbook as Excel writes it: shared and inline strings, numbers, a date and a percent
 * through cell styles, a boolean, and a second sheet.
 */
export async function minimalXlsx() {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  )
  zip.file("_rels/.rels", relationships([["rId1", "officeDocument", "xl/workbook.xml"]]))
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Flights" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  )
  zip.file(
    "xl/_rels/workbook.xml.rels",
    relationships([
      ["rId1", "worksheet", "worksheets/sheet1.xml"],
      ["rId2", "worksheet", "/xl/worksheets/sheet2.xml"],
      ["rId3", "sharedStrings", "sharedStrings.xml"],
      ["rId4", "styles", "styles.xml"],
    ]),
  )
  zip.file(
    "xl/sharedStrings.xml",
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><r><t>Hotel </t></r><r><t>&amp; taxes</t></r></si></sst>',
  )
  zip.file(
    "xl/styles.xml",
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts><numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yy;@"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="9"/><xf numFmtId="20"/></cellXfs></styleSheet>',
  )
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c><c r="C1" t="str"><f>TODAY()</f><v>When</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>1234.5</v></c><c r="C3" s="1"><v>45931</v></c><c r="D3" s="2"><v>0.125</v></c><c r="E3" t="b"><v>1</v></c><c r="F3" s="3"><v>0.5</v></c><c r="G3"><f>B3*C3</f></c></row>' +
      "</sheetData></worksheet>",
  )
  zip.file(
    "xl/worksheets/sheet2.xml",
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c><v>0.1</v></c><c><v>0.2</v></c></row></sheetData></worksheet>',
  )
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

/**
 * A two-slide deck: a title placeholder placed by its layout, a body with bullets and a link, a
 * picture, a table, and a plain shape with a fill. The theme supplies the colors.
 */
export async function minimalPptx(options: { slides?: number } = {}) {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
  )
  zip.file("_rels/.rels", relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]))
  const count = options.slides ?? 2
  const ids = Array.from({ length: count }, (_, index) => index + 1)
  zip.file(
    "ppt/presentation.xml",
    `<p:presentation ${PRESENTATION}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids
      .map((id) => `<p:sldId id="${255 + id}" r:id="rId${id + 1}"/>`)
      .join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  )
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relationships([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ...ids.map((id): [string, string, string] => [
        `rId${id + 1}`,
        "slide",
        `slides/slide${id}.xml`,
      ]),
    ]),
  )
  zip.file(
    "ppt/theme/theme1.xml",
    `<a:theme ${DRAWING} name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
  )
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<p:sldMaster ${PRESENTATION}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>` +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:t/></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>',
  )
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relationships([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "theme", "../theme/theme1.xml"],
    ]),
  )
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<p:sldLayout ${PRESENTATION}><p:cSld><p:spTree>` +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="1828800"/><a:ext cx="10972800" cy="4000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>' +
      "</p:spTree></p:cSld></p:sldLayout>",
  )
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
  )
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  )
  zip.file("ppt/media/image1.png", png)
  for (const id of ids) {
    zip.file(
      `ppt/slides/slide${id}.xml`,
      `<p:sld ${PRESENTATION}><p:cSld>${
        id === 2
          ? '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg>'
          : ""
      }<p:spTree>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${id}"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>Trip plan ${id}</a:t></a:r></a:p></p:txBody></p:sp>` +
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit fontScale="50000"/></a:bodyPr><a:p><a:r><a:rPr/><a:t>Fly Saturday</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr b="1"><a:hlinkClick r:id="rId2"/></a:rPr><a:t>Hotel link</a:t></a:r></a:p></p:txBody></p:sp>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Badge"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="2700000"><a:off x="9144000" y="4572000"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1200"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Draft</a:t></a:r></a:p></p:txBody></p:sp>' +
        '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="Beach"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr><a:xfrm><a:off x="609600" y="5486400"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>' +
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="6096000" y="5486400"/><a:ext cx="4572000" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="3048000"/><a:gridCol w="1524000"/></a:tblGrid><a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Flights</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>$640</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
        "</p:spTree></p:cSld></p:sld>",
    )
    zip.file(
      `ppt/slides/_rels/slide${id}.xml.rels`,
      relationships([
        ["rId1", "image", "../media/image1.png"],
        ["rId3", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ]).replace(
        "</Relationships>",
        `<Relationship Id="rId2" Type="${REL}/hyperlink" Target="https://example.com/hotel" TargetMode="External"/></Relationships>`,
      ),
    )
  }
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}
