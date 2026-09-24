import { createHash } from "node:crypto"
import { extname } from "node:path"
import mammoth from "mammoth"
import {
  DOCX_MIME_TYPE,
  MAX_DOCUMENTS_PER_MESSAGE,
  MAX_EXTRACTED_DOCUMENT_CHARS,
  MAX_PDF_PAGES,
  MAX_RAW_DOCUMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS,
  normalizedDocumentMimeType,
  PDF_MIME_TYPE,
} from "./document-constraints.js"
import { describeError } from "./errors.js"
import { safeAttachmentName } from "./images.js"
import type { DocumentContentPart, DocumentKind } from "./types.js"

export {
  DOCX_MIME_TYPE,
  MAX_DOCUMENTS_PER_MESSAGE,
  MAX_EXTRACTED_DOCUMENT_CHARS,
  MAX_RAW_DOCUMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS,
  PDF_MIME_TYPE,
} from "./document-constraints.js"

import { fromBufferPromise } from "yauzl"

const TEXT_MIME_BY_EXTENSION = new Map<string, string>([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".jsx", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".json", "application/json"],
  [".jsonl", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
  [".xml", "application/xml"],
])

export async function createDocumentAttachment(
  bytes: Uint8Array,
  name: string,
  declaredMimeType?: string,
): Promise<DocumentContentPart> {
  if (bytes.byteLength === 0) throw new Error("Document data is empty.")
  if (bytes.byteLength > MAX_RAW_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds the ${MAX_RAW_DOCUMENT_BYTES / (1024 * 1024)} MB file limit.`)
  }

  const safeName = safeAttachmentName(name, "document.txt")
  const extension = extname(safeName).toLowerCase()
  const declared = normalizedDocumentMimeType(declaredMimeType)
  const rawDeclared = declaredMimeType?.split(";", 1)[0]?.trim().toLowerCase()
  if (extension === ".doc" || rawDeclared === "application/msword") {
    throw new Error("Legacy Word .doc files are not supported. Save the document as .docx first.")
  }
  if (declaredMimeType && !declared && rawDeclared !== "application/octet-stream") {
    throw new Error(`Unsupported document MIME type: ${declaredMimeType}`)
  }
  const mismatch = () =>
    new Error(`Document data does not match its declared MIME type (${declared}).`)

  // Snapshot before asynchronous parsing so validation, extraction, and identity use the
  // same bytes.
  const source = Buffer.from(bytes)
  const attachment = (extracted: {
    kind: DocumentKind
    mimeType: string
    text: string
    truncated: boolean
    pageCount?: number
  }): DocumentContentPart => ({
    type: "document",
    kind: extracted.kind,
    data: source.toString("base64"),
    extractedText: extracted.text,
    mimeType: extracted.mimeType,
    name: safeName,
    sizeBytes: source.byteLength,
    sha256: createHash("sha256").update(source).digest("hex"),
    truncated: extracted.truncated,
    ...(extracted.pageCount === undefined ? {} : { pageCount: extracted.pageCount }),
  })

  if (new TextDecoder("latin1").decode(source.subarray(0, 1024)).includes("%PDF-")) {
    if (declared && declared !== PDF_MIME_TYPE) throw mismatch()
    // PDF.js's worker module registers its own in-process handler. Explicit imports let both
    // Bun and Electron bundle it instead of resolving an absent pdf.worker.mjs at runtime.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    // PDF.js may transfer the buffer it is given, so hand it a copy of the snapshot.
    const loadingTask = getDocument({ data: Uint8Array.from(source), useSystemFonts: true })
    try {
      const pdf = await loadingTask.promise
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new Error(`PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}.`)
      }
      const chunks: string[] = []
      let length = 0
      let truncated = false
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        let pageText = ""
        for (const item of content.items) {
          if (!("str" in item)) continue
          if (item.str) {
            if (pageText && !/[\s-]$/.test(pageText) && !/^[,.;:!?%)\]}]/.test(item.str))
              pageText += " "
            pageText += item.str
          }
          if (item.hasEOL && !pageText.endsWith("\n")) pageText += "\n"
        }
        pageText = pageText.trim()
        page.cleanup()
        if (!pageText) continue
        const chunk = `${chunks.length === 0 ? "" : "\n\n"}[Page ${pageNumber}]\n${pageText}`
        const remaining = MAX_EXTRACTED_DOCUMENT_CHARS - length
        if (chunk.length > remaining) {
          chunks.push(chunk.slice(0, Math.max(0, remaining)))
          truncated = true
          break
        }
        chunks.push(chunk)
        length += chunk.length
      }
      const text = normalizedExtractedText(chunks.join(""))
      return attachment({
        kind: "pdf",
        mimeType: PDF_MIME_TYPE,
        text:
          text ||
          `[PDF has ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} but no extractable text. It may be scanned or contain only graphics or form fields. OCR is not available.]`,
        truncated,
        pageCount: pdf.numPages,
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes("PDF has ")) throw error
      throw new Error(`Could not read PDF: ${describeError(error)}`)
    } finally {
      await loadingTask.destroy()
    }
  }
  if (extension === ".pdf" || declared === PDF_MIME_TYPE)
    throw new Error(`${safeName} is not a valid PDF.`)

  if (extension === ".docx" || declared === DOCX_MIME_TYPE) {
    if (declared && declared !== DOCX_MIME_TYPE) throw mismatch()
    const zip =
      source[0] === 0x50 &&
      source[1] === 0x4b &&
      ((source[2] === 0x03 && source[3] === 0x04) ||
        (source[2] === 0x05 && source[3] === 0x06) ||
        (source[2] === 0x07 && source[3] === 0x08))
    if (!zip) throw new Error(`${safeName} is not a valid DOCX file.`)
    try {
      await validateDocxArchive(source)
      const normalized = normalizedExtractedText(
        (await mammoth.extractRawText({ buffer: source })).value,
      )
      if (!normalized) throw new Error("the document contains no extractable text")
      return attachment({
        kind: "docx",
        mimeType: DOCX_MIME_TYPE,
        text: normalized.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS),
        truncated: normalized.length > MAX_EXTRACTED_DOCUMENT_CHARS,
      })
    } catch (error) {
      throw new Error(`Could not read ${safeName}: ${describeError(error)}`)
    }
  }

  const sample = source.subarray(0, 8_000)
  let controls = 0
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1
  }
  if (sample.includes(0) || controls / sample.length > 0.3)
    throw new Error(`${safeName} is not a UTF-8 text file.`)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source)
  } catch {
    throw new Error(`${safeName} is not valid UTF-8 text.`)
  }
  if (!text.trim()) throw new Error(`${safeName} contains no text.`)
  return attachment({
    kind: "text",
    mimeType: declared ?? TEXT_MIME_BY_EXTENSION.get(extension) ?? "text/plain",
    text: text.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS),
    truncated: text.length > MAX_EXTRACTED_DOCUMENT_CHARS,
  })
}

export function validateDocumentAttachments(documents: readonly DocumentContentPart[]) {
  if (documents.length > MAX_DOCUMENTS_PER_MESSAGE) {
    throw new Error(`Attach at most ${MAX_DOCUMENTS_PER_MESSAGE} documents to one message.`)
  }
  if (
    documents.reduce((total, document) => total + document.sizeBytes, 0) > MAX_TOTAL_DOCUMENT_BYTES
  ) {
    throw new Error(
      `Attached documents must total at most ${MAX_TOTAL_DOCUMENT_BYTES / (1024 * 1024)} MB.`,
    )
  }
  const chars = documents.reduce((total, document) => total + document.extractedText.length, 0)
  if (chars > MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS) {
    throw new Error(
      `Attached documents contain too much text. Keep the extracted content under ${MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS.toLocaleString()} characters per message.`,
    )
  }
}

function normalizedExtractedText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

const MAX_ENTRIES = 10_000
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024

/** Verify every entry with bounded streaming inflation before Mammoth materializes XML. */
export async function validateDocxArchive(bytes: Buffer) {
  const zip = await fromBufferPromise(bytes, { validateEntrySizes: true, strictFileNames: true })
  try {
    if (zip.entryCount === 0 || zip.entryCount > MAX_ENTRIES)
      throw new Error("invalid DOCX entry count")
    const names = new Set<string>()
    let totalBytes = 0
    for await (const entry of zip.eachEntry()) {
      if (names.has(entry.fileName)) throw new Error("duplicate DOCX archive entry")
      names.add(entry.fileName)
      if (entry.isEncrypted()) throw new Error("encrypted DOCX files are not supported")
      // Mammoth reads local names, whereas yauzl indexes central names. Require an
      // unambiguous package.
      const local = await zip.readLocalFileHeaderPromise(entry)
      if (!local.fileName.equals(entry.fileNameRaw)) throw new Error("inconsistent DOCX entry name")
      if (
        entry.fileName === "word/document.xml" &&
        entry.uncompressedSize > MAX_DOCUMENT_XML_BYTES
      ) {
        throw new Error("main document XML exceeds the 16 MB safety limit")
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > MAX_UNCOMPRESSED_BYTES)
        throw new Error("DOCX expands beyond the 100 MB safety limit")

      // yauzl aborts the stream as soon as inflated data exceeds the declared size.
      // Draining (without retaining chunks) verifies compressed entries as well as metadata.
      const stream = await zip.openReadStreamPromise(entry)
      for await (const _chunk of stream) {
        // The verified data is read again by Mammoth after the archive passes validation.
      }
    }
    if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
      throw new Error("not a valid DOCX file")
    }
  } finally {
    zip.close()
  }
}
