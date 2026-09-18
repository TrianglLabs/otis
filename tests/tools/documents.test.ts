import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DOMParser } from "@xmldom/xmldom"
import JSZip from "jszip"
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as attachments from "../../src/inference/documents.js"
import { editLocalDocument } from "../../src/tools/documents.js"
import { minimalDocx } from "../inference/support/document-fixtures.js"

// Keep real disk I/O while allowing a deterministic concurrent save during publication.
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe("DOCX editing", () => {
  it.each([
    ["Senior Staff Engineer", "Senior Staff ", "Engineer"],
    ["Lead Senior Engineer", "Lead Senior ", "Engineer"],
    ["Senior Engineer II", "Senior ", "Engineer II"],
    ["Senior EngXineer", "Senior ", "EngXineer"],
    ["Engineer", "", "Engineer"],
  ])("preserves existing runs when changing text to %s", async (replacement, bold, italic) => {
    const context = await testContext()
    const source = await docxParagraph(
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Senior </w:t></w:r>' +
        "<w:r><w:rPr><w:i/></w:rPr><w:t>Engineer</w:t></w:r>",
    )
    await fs.writeFile(join(context.cwd, "resume.docx"), source)
    await editLocalDocument(wordEdit("Senior Engineer", replacement), context)
    const document = await readDocxXml(join(context.cwd, "resume-edited.docx"))
    const runs = Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "r"))
    expect(runs.map((run) => run.textContent)).toEqual([bold, italic])
    expect(runs[0].getElementsByTagNameNS(WORD_NAMESPACE, "b").length).toBe(1)
    expect(runs[1].getElementsByTagNameNS(WORD_NAMESPACE, "i").length).toBe(1)
    expect(await fs.readFile(join(context.cwd, "resume.docx"))).toEqual(source)
  })

  it.each([
    "tab",
    "br",
    "cr",
    "sym",
    "drawing",
    "fldChar",
  ])("does not match through a %s boundary, but can edit text on either side", async (boundary) => {
    const context = await testContext()
    const attributes = boundary === "sym" ? ' w:font="Wingdings" w:char="F0A7"' : ""
    await fs.writeFile(
      join(context.cwd, "resume.docx"),
      await docxParagraph(`<w:r><w:t>Name</w:t><w:${boundary}${attributes}/><w:t>Title</w:t></w:r>`),
    )
    await expect(editLocalDocument(wordEdit("NameTitle", "Changed"), context)).rejects.toThrow("not found")
    await expect(fs.readFile(join(context.cwd, "resume-edited.docx"))).rejects.toMatchObject({ code: "ENOENT" })
    await editLocalDocument(wordEdit("Title", "Role"), context)
    const document = await readDocxXml(join(context.cwd, "resume-edited.docx"))
    expect(Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "t")).map((node) => node.textContent)).toEqual([
      "Name",
      "Role",
    ])
    expect(document.getElementsByTagNameNS(WORD_NAMESPACE, boundary).length).toBe(1)
  })

  it("rejects overlapping ambiguous matches", async () => {
    const context = await testContext()
    await fs.writeFile(join(context.cwd, "resume.docx"), await minimalDocx("aaa"))
    await expect(editLocalDocument(wordEdit("aa", "b"), context)).rejects.toThrow("appears 2 times")
    await expect(fs.readFile(join(context.cwd, "resume-edited.docx"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("document replacement conflicts", () => {
  it.each(["preparation", "publication"])("preserves a concurrent save during %s", async (stage) => {
    const context = await testContext()
    const path = join(context.cwd, "resume.docx")
    const source = await docxParagraph("<w:r><w:t>First draft</w:t></w:r>")
    const concurrent = await docxParagraph("<w:r><w:t>Other draft</w:t></w:r>")
    expect(concurrent.length).toBe(source.length)
    await fs.writeFile(path, source)

    if (stage === "preparation") {
      const extract = attachments.createDocumentAttachment
      vi.spyOn(attachments, "createDocumentAttachment").mockImplementationOnce(async (...args) => {
        const value = await extract(...args)
        await fs.writeFile(path, concurrent)
        return value
      })
    } else {
      const write = fs.writeFile
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        await write(file, data, options)
        if (typeof file === "string" && file.endsWith(".tmp")) await write(path, concurrent)
      })
    }

    await expect(editLocalDocument({ ...wordEdit("First", "Final"), replaceOriginal: true }, context)).rejects.toThrow(
      "source document changed",
    )
    expect(await fs.readFile(path)).toEqual(Buffer.from(concurrent))
    expect(await fs.readdir(context.cwd)).toEqual(["resume.docx"])
  })

  it("does not recreate a source removed during preparation", async () => {
    const context = await testContext()
    const path = join(context.cwd, "resume.docx")
    await fs.writeFile(path, await minimalDocx("First draft"))
    const extract = attachments.createDocumentAttachment
    vi.spyOn(attachments, "createDocumentAttachment").mockImplementationOnce(async (...args) => {
      const value = await extract(...args)
      await fs.unlink(path)
      return value
    })
    await expect(editLocalDocument({ ...wordEdit("First", "Final"), replaceOriginal: true }, context)).rejects.toThrow(
      "source document changed",
    )
    expect(await fs.readdir(context.cwd)).toEqual([])
  })

  it("keeps a private backup of the exact original when replacement succeeds", async () => {
    const context = await testContext()
    const source = await minimalDocx("First draft")
    await fs.writeFile(join(context.cwd, "resume.docx"), source)
    const result = await editLocalDocument({ ...wordEdit("First", "Final"), replaceOriginal: true }, context)
    const backup = result.output.match(/backed up at (.+)\.\n/)?.[1]
    if (!backup) throw new Error("The tool did not return a backup path")
    expect(await fs.readFile(backup)).toEqual(Buffer.from(source))
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600)
  })
})

describe("PDF signature detection", () => {
  it("fills an unsigned form even when comments mention /ByteRange", async () => {
    const context = await testContext()
    const pdf = await formPdf()
    const source = Buffer.concat([
      Buffer.from(await pdf.save()),
      Buffer.from("\n% /ByteRange is a PDF dictionary key\n"),
    ])
    await fs.writeFile(join(context.cwd, "form.pdf"), source)
    await editLocalDocument(pdfEdit(), context)
    const edited = await PDFDocument.load(await fs.readFile(join(context.cwd, "form-edited.pdf")))
    expect(edited.getForm().getTextField("Name").getText()).toBe("Ada")
    expect(await fs.readFile(join(context.cwd, "form.pdf"))).toEqual(source)
  })

  it.each([
    "direct",
    "indirect",
    "compressed",
    "escaped",
  ])("rejects signature dictionaries stored as %s objects before writing", async (storage) => {
    const context = await testContext()
    const pdf = await formPdf()
    const signature = pdf.context.obj({ ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of("010203") })
    const field = pdf.context.obj({
      FT: "Sig",
      T: PDFString.of("Signature"),
      V: storage === "direct" ? signature : pdf.context.register(signature),
    })
    pdf.getForm().acroForm.addField(pdf.context.register(field))
    let source = Buffer.from(await pdf.save({ useObjectStreams: storage === "compressed" }))
    if (storage === "compressed") expect(source.includes(Buffer.from("/ByteRange"))).toBe(false)
    if (storage === "escaped") {
      // Keep the same byte length so the original cross-reference offsets remain valid.
      const encoded = source.toString("latin1").replace("/ByteRange [ 0", "/Byte#52ange[0")
      expect(encoded).toContain("/Byte#52ange")
      expect(Buffer.byteLength(encoded, "latin1")).toBe(source.length)
      source = Buffer.from(encoded, "latin1")
    }
    await fs.writeFile(join(context.cwd, "form.pdf"), source)
    await expect(editLocalDocument(pdfEdit(), context)).rejects.toThrow("Signed PDFs cannot be edited")
    expect(await fs.readFile(join(context.cwd, "form.pdf"))).toEqual(source)
    expect(await fs.readdir(context.cwd)).toEqual(["form.pdf"])
  })

  it("allows an empty signature field while editing another field", async () => {
    const context = await testContext()
    const pdf = await formPdf()
    const field = pdf.context.obj({ FT: "Sig", T: PDFString.of("Signature") })
    pdf.getForm().acroForm.addField(pdf.context.register(field))
    await fs.writeFile(join(context.cwd, "form.pdf"), await pdf.save())
    await editLocalDocument(pdfEdit(), context)
    const edited = await PDFDocument.load(await fs.readFile(join(context.cwd, "form-edited.pdf")))
    expect(edited.getForm().getTextField("Name").getText()).toBe("Ada")
    expect(edited.getForm().getSignature("Signature").acroField.dict.has(PDFName.of("V"))).toBe(false)
  })

  it("rejects a certification signature even without a form signature field", async () => {
    const context = await testContext()
    const pdf = await formPdf()
    pdf.catalog.set(
      PDFName.of("Perms"),
      pdf.context.obj({
        DocMDP: { Type: "Sig", ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of("010203") },
      }),
    )
    const source = Buffer.from(await pdf.save())
    await fs.writeFile(join(context.cwd, "form.pdf"), source)
    await expect(editLocalDocument(pdfEdit(), context)).rejects.toThrow("Signed PDFs cannot be edited")
    expect(await fs.readFile(join(context.cwd, "form.pdf"))).toEqual(source)
    expect(await fs.readdir(context.cwd)).toEqual(["form.pdf"])
  })
})

async function testContext() {
  const cwd = await fs.mkdtemp(join(tmpdir(), "otis-documents-"))
  const dataDirectory = await fs.mkdtemp(join(tmpdir(), "otis-document-backups-"))
  directories.push(cwd, dataDirectory)
  return { cwd, dataDirectory }
}

function wordEdit(oldText: string, newText: string) {
  return {
    path: "resume.docx",
    replaceOriginal: false,
    operation: { kind: "replace_text" as const, replacements: [{ old: oldText, new: newText }] },
  }
}

function pdfEdit() {
  return {
    path: "form.pdf",
    replaceOriginal: false,
    operation: { kind: "fill_pdf_form" as const, fields: { Name: "Ada" } },
  }
}

async function docxParagraph(body: string) {
  const zip = await JSZip.loadAsync(await minimalDocx("placeholder"))
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p>${body}</w:p></w:body></w:document>`,
  )
  return zip.generateAsync({ type: "nodebuffer" })
}

async function readDocxXml(path: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(path))
  const part = zip.file("word/document.xml")
  if (!part) throw new Error("Missing DOCX document part")
  return new DOMParser().parseFromString(await part.async("string"), "application/xml")
}

async function formPdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage()
  pdf.getForm().createTextField("Name").addToPage(page)
  return pdf
}
