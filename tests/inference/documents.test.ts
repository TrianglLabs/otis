import { createHash } from "node:crypto"
import mammoth from "mammoth"
import { describe, expect, it, vi } from "vitest"
import { parsePastedAttachmentPaths } from "../../src/inference/attachments.js"
import {
  createDocumentAttachment,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  validateDocumentAttachments,
} from "../../src/inference/documents.js"
import type { DocumentContentPart } from "../../src/inference/types.js"
import { minimalDocx, minimalPdf, setZipEntrySize } from "./support/document-fixtures.js"

describe("document attachments", () => {
  it("preserves original text bytes and derives portable model text", async () => {
    const bytes = new TextEncoder().encode("# Notes\r\n\r\nHello from Otis.\r\n")

    const document = await createDocumentAttachment(bytes, "notes.md", "text/markdown; charset=utf-8")

    expect(document).toMatchObject({
      type: "document",
      kind: "text",
      name: "notes.md",
      mimeType: "text/markdown",
      extractedText: "# Notes\r\n\r\nHello from Otis.\r\n",
      sizeBytes: bytes.byteLength,
      truncated: false,
    })
    expect(Buffer.from(document.data, "base64")).toEqual(Buffer.from(bytes))
    expect(document.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  })

  it.each([
    ["sample.py", "    return 42\n"],
    ["notes.md", "First line  \nSecond line\n"],
    ["data.tsv", "\tvalue\t\r\n"],
  ])("preserves significant whitespace in %s", async (name, text) => {
    const document = await createDocumentAttachment(new TextEncoder().encode(text), name)
    expect(document.extractedText).toBe(text)
  })

  it("rejects PDFs without a text layer instead of treating page labels as content", async () => {
    await expect(createDocumentAttachment(minimalPdf(""), "blank.pdf")).resolves.toMatchObject({
      kind: "pdf",
      pageCount: 1,
      extractedText: expect.stringContaining("no extractable text"),
    })
  })

  it("rejects forged DOCX sizes during inflation, before Mammoth reads the document", async () => {
    const bytes = await minimalDocx("a".repeat(1024 * 1024))
    setZipEntrySize(bytes, "word/document.xml", 1024)
    const extract = vi.spyOn(mammoth, "extractRawText")

    await expect(createDocumentAttachment(bytes, "forged.docx")).rejects.toThrow(/size|byte/i)
    expect(extract).not.toHaveBeenCalled()
  })

  it("extracts text and page metadata from a PDF while retaining its bytes", async () => {
    const bytes = minimalPdf("Hello from a PDF")

    const document = await createDocumentAttachment(bytes, "report.pdf", PDF_MIME_TYPE)

    expect(document).toMatchObject({
      kind: "pdf",
      mimeType: PDF_MIME_TYPE,
      name: "report.pdf",
      pageCount: 1,
      truncated: false,
    })
    expect(document.extractedText).toContain("[Page 1]")
    expect(document.extractedText).toContain("Hello from a PDF")
    expect(Buffer.from(document.data, "base64")).toEqual(Buffer.from(bytes))
  })

  it("extracts Word text from the original DOCX package", async () => {
    const bytes = await minimalDocx("A native Word attachment")

    const document = await createDocumentAttachment(bytes, "brief.docx", DOCX_MIME_TYPE)

    expect(document).toMatchObject({
      kind: "docx",
      mimeType: DOCX_MIME_TYPE,
      name: "brief.docx",
      extractedText: "A native Word attachment",
      truncated: false,
    })
    expect(Buffer.from(document.data, "base64")).toEqual(Buffer.from(bytes))
  })

  it("rejects a DOCX whose archive metadata exceeds the expansion safety limit", async () => {
    const bytes = await minimalDocx("small")
    setZipEntrySize(bytes, "word/document.xml", 17 * 1024 * 1024)

    await expect(createDocumentAttachment(bytes, "bomb.docx", DOCX_MIME_TYPE)).rejects.toThrow(
      "main document XML exceeds the 16 MB safety limit",
    )
  })

  it("rejects disguised, binary, empty, and legacy Word inputs", async () => {
    await expect(
      createDocumentAttachment(new TextEncoder().encode("not a pdf"), "fake.pdf", PDF_MIME_TYPE),
    ).rejects.toThrow("not a valid PDF")
    await expect(createDocumentAttachment(new Uint8Array([0, 1, 2, 3]), "blob.txt")).rejects.toThrow(
      "not a UTF-8 text file",
    )
    await expect(createDocumentAttachment(new Uint8Array(), "empty.txt")).rejects.toThrow("empty")
    await expect(createDocumentAttachment(new Uint8Array([1]), "old.doc", "application/msword")).rejects.toThrow(
      "Legacy Word .doc",
    )
  })

  it("validates aggregate limits and parses shell-escaped document paths", async () => {
    const document = await createDocumentAttachment(new TextEncoder().encode("small"), "small.txt")
    const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...document, name: `${index}.txt` }))

    expect(() => validateDocumentAttachments(tooMany)).toThrow("at most 10 documents")
    expect(parsePastedAttachmentPaths("'notes one.md' report.pdf photo.png")).toEqual([
      "notes one.md",
      "report.pdf",
      "photo.png",
    ])
  })

  it("rejects tampered aggregate metadata before use", () => {
    const oversized = {
      type: "document",
      kind: "text",
      data: "YQ==",
      extractedText: "a",
      mimeType: "text/plain",
      name: "a.txt",
      sizeBytes: 31 * 1024 * 1024,
      sha256: "0".repeat(64),
      truncated: false,
    } satisfies DocumentContentPart

    expect(() => validateDocumentAttachments([oversized])).toThrow("total at most 30 MB")
  })
})
