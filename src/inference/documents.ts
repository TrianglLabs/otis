import { createHash } from "node:crypto"
import { basename, extname } from "node:path"
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
import { validateDocxArchive } from "./docx-archive.js"
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

const LEGACY_WORD_MIME_TYPE = "application/msword"

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

type ExtractedDocument = {
  kind: DocumentKind
  mimeType: string
  text: string
  truncated: boolean
  pageCount?: number
}

export async function createDocumentAttachment(
  bytes: Uint8Array,
  name: string,
  declaredMimeType?: string,
): Promise<DocumentContentPart> {
  if (bytes.byteLength === 0) throw new Error("Document data is empty.")
  if (bytes.byteLength > MAX_RAW_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds the ${formatMegabytes(MAX_RAW_DOCUMENT_BYTES)} MB file limit.`)
  }

  const safeName = attachmentName(name)
  const extension = extname(safeName).toLowerCase()
  const declared = normalizedDocumentMimeType(declaredMimeType)
  const rawDeclared = declaredMimeType?.split(";", 1)[0]?.trim().toLowerCase()
  if (extension === ".doc" || rawDeclared === LEGACY_WORD_MIME_TYPE) {
    throw new Error("Legacy Word .doc files are not supported. Save the document as .docx first.")
  }
  if (declaredMimeType && !declared && rawDeclared !== "application/octet-stream") {
    throw new Error(`Unsupported document MIME type: ${declaredMimeType}`)
  }

  // Snapshot before asynchronous parsing so validation, extraction, and identity use the same bytes.
  const source = Buffer.from(bytes)
  const extracted = await extractDocument(source, safeName, extension, declared)
  return {
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
  }
}

export function validateDocumentAttachments(documents: readonly DocumentContentPart[]) {
  if (documents.length > MAX_DOCUMENTS_PER_MESSAGE) {
    throw new Error(`Attach at most ${MAX_DOCUMENTS_PER_MESSAGE} documents to one message.`)
  }
  const rawBytes = documents.reduce((total, document) => total + document.sizeBytes, 0)
  if (rawBytes > MAX_TOTAL_DOCUMENT_BYTES) {
    throw new Error(`Attached documents must total at most ${formatMegabytes(MAX_TOTAL_DOCUMENT_BYTES)} MB.`)
  }
  const extractedChars = documents.reduce((total, document) => total + document.extractedText.length, 0)
  if (extractedChars > MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS) {
    throw new Error(
      `Attached documents contain too much text. Keep the extracted content under ${MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS.toLocaleString()} characters per message.`,
    )
  }
}

async function extractDocument(
  bytes: Uint8Array,
  name: string,
  extension: string,
  declaredMimeType: string | undefined,
): Promise<ExtractedDocument> {
  if (looksLikePdf(bytes)) {
    assertDeclaredKind(declaredMimeType, "pdf")
    return extractPdf(bytes)
  }
  if (extension === ".pdf" || declaredMimeType === PDF_MIME_TYPE) {
    throw new Error(`${name} is not a valid PDF.`)
  }

  if (extension === ".docx" || declaredMimeType === DOCX_MIME_TYPE) {
    assertDeclaredKind(declaredMimeType, "docx")
    if (!looksLikeZip(bytes)) throw new Error(`${name} is not a valid DOCX file.`)
    return extractDocx(bytes, name)
  }

  assertDeclaredKind(declaredMimeType, "text")
  return extractText(bytes, name, declaredMimeType ?? TEXT_MIME_BY_EXTENSION.get(extension) ?? "text/plain")
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  // PDF.js's worker module registers its own in-process handler. Explicit imports let both
  // Bun and Electron bundle it instead of resolving an absent pdf.worker.mjs at runtime.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loadingTask = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true })
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
      const pageText = pdfPageText(content.items)
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
    return {
      kind: "pdf",
      mimeType: PDF_MIME_TYPE,
      text:
        text ||
        `[PDF has ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} but no extractable text. It may be scanned or contain only graphics or form fields. OCR is not available.]`,
      truncated,
      pageCount: pdf.numPages,
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("PDF has ")) {
      throw error
    }
    throw new Error(`Could not read PDF: ${errorMessage(error)}`)
  } finally {
    await loadingTask.destroy()
  }
}

async function extractDocx(bytes: Uint8Array, name: string): Promise<ExtractedDocument> {
  try {
    await validateDocxArchive(Buffer.from(bytes))
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    const normalized = normalizedExtractedText(result.value)
    if (!normalized) throw new Error("the document contains no extractable text")
    const truncated = normalized.length > MAX_EXTRACTED_DOCUMENT_CHARS
    return {
      kind: "docx",
      mimeType: DOCX_MIME_TYPE,
      text: normalized.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS),
      truncated,
    }
  } catch (error) {
    throw new Error(`Could not read ${name}: ${errorMessage(error)}`)
  }
}

function extractText(bytes: Uint8Array, name: string, mimeType: string): ExtractedDocument {
  if (looksBinary(bytes)) throw new Error(`${name} is not a UTF-8 text file.`)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${name} is not valid UTF-8 text.`)
  }
  if (!text.trim()) throw new Error(`${name} contains no text.`)
  const truncated = text.length > MAX_EXTRACTED_DOCUMENT_CHARS
  return {
    kind: "text",
    mimeType,
    text: text.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS),
    truncated,
  }
}

function pdfPageText(items: readonly unknown[]) {
  let text = ""
  for (const item of items) {
    if (!isPdfTextItem(item)) continue
    if (item.str) {
      if (text && !/[\s-]$/.test(text) && !/^[,.;:!?%)\]}]/.test(item.str)) text += " "
      text += item.str
    }
    if (item.hasEOL && !text.endsWith("\n")) text += "\n"
  }
  return text.trim()
}

function isPdfTextItem(value: unknown): value is { str: string; hasEOL: boolean } {
  return typeof value === "object" && value !== null && "str" in value && typeof value.str === "string"
}

function normalizedExtractedText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function looksLikePdf(bytes: Uint8Array) {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  return prefix.includes("%PDF-")
}

function looksLikeZip(bytes: Uint8Array) {
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  )
}

function looksBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_000))
  if (sample.includes(0)) return true
  let controls = 0
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1
  }
  return sample.length > 0 && controls / sample.length > 0.3
}

function assertDeclaredKind(mimeType: string | undefined, kind: DocumentKind) {
  if (!mimeType) return
  const matches =
    (kind === "pdf" && mimeType === PDF_MIME_TYPE) ||
    (kind === "docx" && mimeType === DOCX_MIME_TYPE) ||
    (kind === "text" && mimeType !== PDF_MIME_TYPE && mimeType !== DOCX_MIME_TYPE)
  if (!matches) throw new Error(`Document data does not match its declared MIME type (${mimeType}).`)
}

function attachmentName(name: string) {
  const safeName = [...basename(name)]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .trim()
  return safeName || "document.txt"
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x1f || codePoint === 0x7f
}

function formatMegabytes(bytes: number) {
  return Math.floor(bytes / (1024 * 1024))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
