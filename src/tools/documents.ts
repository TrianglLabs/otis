import { createHash, randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from "@xmldom/xmldom"
import { createPatch } from "diff"
import JSZip from "jszip"
import { workspaceArtifactReference } from "../artifacts/files.js"
import { DOCX_MIME_TYPE, MAX_RAW_DOCUMENT_BYTES, PDF_MIME_TYPE } from "../inference/document-constraints.js"
import { createDocumentAttachment } from "../inference/documents.js"
import { validateDocxArchive } from "../inference/docx-archive.js"
import { localDataDirectory } from "../local/paths.js"
import { editedDocumentPath } from "./document-path.js"
import type { EditDocumentOperation, ToolCall, ToolContext, ToolResult } from "./types.js"
import { isNotFoundError, resolveWorkspacePath } from "./workspace.js"

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
const EDITABLE_WORD_PART = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/
const WORD_TEXT_BOUNDARIES = new Set([
  "tab",
  "br",
  "cr",
  "drawing",
  "pict",
  "object",
  "sym",
  "noBreakHyphen",
  "softHyphen",
  "fldChar",
  "instrText",
  "delText",
  "del",
])

type EditDocumentInput = Extract<ToolCall, { name: "edit_document" }>["input"]

type PreparedDocument = {
  bytes: Buffer
  summary: string
  diff?: string
}

export async function editLocalDocument(input: EditDocumentInput, context: ToolContext): Promise<ToolResult> {
  const paths = await resolveDocumentPaths(input, context)
  context.signal?.throwIfAborted()
  const source = await readBoundedDocument(paths.source)
  const prepared = await prepareDocument(source, paths.extension, input.operation, basename(paths.target))
  context.signal?.throwIfAborted()

  let backup: string | undefined
  if (input.replaceOriginal) {
    await assertDocumentUnchanged(paths.source, source)
    backup = await backupOriginal(paths.source, source, context.cwd ?? process.cwd(), context.dataDirectory)
    try {
      context.signal?.throwIfAborted()
      await publishDocument(paths.target, prepared.bytes, paths.mode, source)
    } catch (error) {
      await rm(backup, { force: true })
      throw error
    }
  } else {
    await publishDocument(paths.target, prepared.bytes, paths.mode)
  }
  const artifact = await workspaceArtifactReference(paths.target, context.cwd ?? process.cwd())
  if (!artifact) throw new Error("The edited document is not previewable in Canvas.")

  const workspacePath = artifact.path
  const disposition = input.replaceOriginal
    ? `Replaced ${workspacePath} after validation. The previous version is backed up at ${backup}.`
    : `Created ${workspacePath}. The original file was not changed.`
  return {
    title: `Edit document: ${paths.target}`,
    output: `${disposition}\n${prepared.summary}`,
    ...(prepared.diff ? { diff: prepared.diff } : {}),
    artifact,
  }
}

export async function inspectPdfForm(bytes: Uint8Array) {
  const pdf = await loadPdf(bytes)
  return pdf
    .getForm()
    .getFields()
    .map((field) => describePdfField(field, pdfLibTypes))
}

async function prepareDocument(
  source: Buffer,
  extension: string,
  operation: EditDocumentOperation,
  outputName: string,
): Promise<PreparedDocument> {
  if (extension === ".docx") {
    if (operation.kind !== "replace_text") {
      throw new Error("DOCX editing requires replacements; form_fields are only valid for PDF forms.")
    }
    return editDocx(source, operation.replacements, outputName)
  }
  if (operation.kind !== "fill_pdf_form") {
    throw new Error(
      "PDF text replacements use the document tool's inspect-pdf/edit-pdf operations; load the documents skill for the edit plan. Use form_fields here for an interactive PDF.",
    )
  }
  return fillPdfForm(source, operation.fields, outputName)
}

async function editDocx(
  source: Buffer,
  replacements: Extract<EditDocumentOperation, { kind: "replace_text" }>["replacements"],
  outputName: string,
): Promise<PreparedDocument> {
  const before = await createDocumentAttachment(source, "source.docx", DOCX_MIME_TYPE)
  const zip = await JSZip.loadAsync(source)
  const parts = Object.keys(zip.files)
    .filter((name) => EDITABLE_WORD_PART.test(name))
    .sort()
  if (!parts.includes("word/document.xml")) throw new Error("The DOCX is missing its main document part.")

  const documents = new Map<string, XmlDocument>()
  for (const part of parts) {
    const file = zip.file(part)
    if (!file) continue
    const xml = await file.async("string")
    documents.set(part, parseWordXml(xml, part))
  }

  for (const replacement of replacements) {
    validateWordReplacement(replacement.old, "old")
    validateWordReplacement(replacement.new, "new")
    const matches = findWordMatches(documents, replacement.old)
    if (matches.length === 0) {
      throw new Error(`DOCX text was not found in one paragraph: ${quotedPreview(replacement.old)}`)
    }
    if (matches.length > 1) {
      throw new Error(`DOCX text appears ${matches.length} times; provide a more specific replacement.`)
    }
    const narrowed = narrowReplacement(replacement.old, replacement.new)
    replaceWordMatch(
      { ...matches[0], offset: matches[0].offset + narrowed.prefixLength },
      narrowed.oldText.length,
      narrowed.newText,
    )
  }

  const serializer = new XMLSerializer()
  for (const [part, document] of documents) zip.file(part, serializer.serializeToString(document))
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  await validateDocxArchive(bytes)
  const after = await createDocumentAttachment(bytes, outputName, DOCX_MIME_TYPE)
  return {
    bytes,
    summary: `Applied ${replacements.length} structure-preserving text replacement${replacements.length === 1 ? "" : "s"}.`,
    diff: createDocumentDiff(outputName, before.extractedText, after.extractedText),
  }
}

type WordMatch = {
  nodes: XmlElement[]
  offset: number
}

function findWordMatches(documents: Map<string, XmlDocument>, oldText: string) {
  const matches: WordMatch[] = []
  for (const document of documents.values()) {
    for (const paragraph of Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "p"))) {
      for (const nodes of wordTextSegments(paragraph)) {
        const text = nodes.map((node) => node.textContent ?? "").join("")
        for (let offset = text.indexOf(oldText); offset !== -1; offset = text.indexOf(oldText, offset + 1)) {
          matches.push({ nodes, offset })
        }
      }
    }
  }
  return matches
}

/** Only consecutive text can match; tabs, breaks, fields and embedded content separate segments. */
function wordTextSegments(paragraph: XmlElement) {
  const segments: XmlElement[][] = []
  let nodes: XmlElement[] = []
  function flush() {
    if (nodes.length) segments.push(nodes)
    nodes = []
  }
  function visit(node: XmlNode) {
    if (node.nodeType !== node.ELEMENT_NODE) return
    const element = node as XmlElement
    if (element.namespaceURI === WORD_NAMESPACE) {
      if (element.localName === "t") {
        nodes.push(element)
        return
      }
      if (element.localName === "rPr" || element.localName === "pPr") return
      if (element.localName === "p" || WORD_TEXT_BOUNDARIES.has(element.localName ?? "")) {
        flush()
        return
      }
    }
    for (const child of Array.from(element.childNodes)) visit(child)
  }
  for (const child of Array.from(paragraph.childNodes)) visit(child)
  flush()
  return segments
}

function replaceWordMatch(match: WordMatch, length: number, replacement: string) {
  const starts: number[] = []
  let total = 0
  for (const node of match.nodes) {
    starts.push(total)
    total += (node.textContent ?? "").length
  }
  // An insertion at a run boundary inherits the preceding run, leaving the following run untouched.
  const firstOffset = length === 0 && match.offset > 0 ? match.offset - 1 : match.offset
  const first = starts.findIndex(
    (start, index) => start <= firstOffset && firstOffset < start + nodeLength(match.nodes[index]),
  )
  const lastOffset = match.offset + length - 1
  const last =
    length === 0
      ? first
      : starts.findIndex((start, index) => start <= lastOffset && lastOffset < start + nodeLength(match.nodes[index]))
  if (first < 0 || last < 0) throw new Error("Could not map the DOCX text replacement to its runs.")

  const firstText = match.nodes[first].textContent ?? ""
  const prefix = firstText.slice(0, match.offset - starts[first])
  if (first === last) {
    const suffix = firstText.slice(match.offset + length - starts[first])
    setWordText(match.nodes[first], `${prefix}${replacement}${suffix}`)
    return
  }

  const lastText = match.nodes[last].textContent ?? ""
  const suffix = lastText.slice(match.offset + length - starts[last])
  setWordText(match.nodes[first], `${prefix}${replacement}`)
  for (let index = first + 1; index < last; index += 1) setWordText(match.nodes[index], "")
  setWordText(match.nodes[last], suffix)
}

/** Keep unchanged edges in their original runs so links and character formatting survive local edits. */
function narrowReplacement(oldText: string, newText: string) {
  let prefixLength = 0
  while (
    prefixLength < oldText.length &&
    prefixLength < newText.length &&
    oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < oldText.length - prefixLength &&
    suffixLength < newText.length - prefixLength &&
    oldText[oldText.length - suffixLength - 1] === newText[newText.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }
  return {
    prefixLength,
    oldText: oldText.slice(prefixLength, oldText.length - suffixLength),
    newText: newText.slice(prefixLength, newText.length - suffixLength),
  }
}

function setWordText(node: XmlElement, value: string) {
  node.textContent = value
  if (/^\s|\s$/.test(value)) node.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve")
  else node.removeAttributeNS(XML_NAMESPACE, "space")
}

function nodeLength(node: XmlElement | undefined) {
  return node?.textContent?.length ?? 0
}

function parseWordXml(xml: string, part: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error(`Could not parse ${part}: document type declarations are not allowed.`)
  try {
    return new DOMParser({
      locator: false,
      onError: (_level, message) => {
        throw new Error(message)
      },
    }).parseFromString(xml, "application/xml")
  } catch (error) {
    throw new Error(`Could not parse ${part}: ${errorMessage(error)}`)
  }
}

function validateWordReplacement(value: string, label: string) {
  if (/[\r\n\t]/.test(value)) {
    throw new Error(`DOCX replacement ${label} text must stay within one paragraph and cannot contain tabs.`)
  }
  if (!hasValidXmlCharacters(value)) {
    throw new Error(`DOCX replacement ${label} text contains characters that are not valid in XML.`)
  }
}

function hasValidXmlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

let pdfLibTypes: typeof import("pdf-lib")

async function loadPdf(bytes: Uint8Array) {
  pdfLibTypes ??= await import("pdf-lib")
  return pdfLibTypes.PDFDocument.load(bytes, { updateMetadata: false })
}

async function fillPdfForm(
  source: Buffer,
  values: Record<string, string>,
  outputName: string,
): Promise<PreparedDocument> {
  const beforeDocument = await createDocumentAttachment(source, "source.pdf", PDF_MIME_TYPE)
  const pdf = await loadPdf(source)
  assertUnsignedPdf(pdf, pdfLibTypes)
  const form = pdf.getForm()
  if (form.hasXFA()) throw new Error("XFA-based PDF forms are not supported because they cannot be updated reliably.")
  const fields = new Map(form.getFields().map((field) => [field.getName(), field]))
  if (fields.size === 0) {
    throw new Error("This PDF has no interactive form fields. Edit its source document and export a new PDF instead.")
  }

  const missing = Object.keys(values).filter((name) => !fields.has(name))
  if (missing.length > 0) {
    throw new Error(`PDF form field${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}.`)
  }

  const before = Object.keys(values).map((name) => describePdfField(requiredPdfField(fields, name), pdfLibTypes))
  for (const [name, value] of Object.entries(values)) setPdfField(requiredPdfField(fields, name), value, pdfLibTypes)
  form.updateFieldAppearances()
  const bytes = Buffer.from(await pdf.save())

  const verified = await loadPdf(bytes)
  const verifiedFields = new Map(
    verified
      .getForm()
      .getFields()
      .map((field) => [field.getName(), field]),
  )
  for (const [name, expected] of Object.entries(values)) {
    const field = verifiedFields.get(name)
    if (!field || pdfFieldValue(field, pdfLibTypes) !== normalizedExpectedPdfValue(field, expected, pdfLibTypes)) {
      throw new Error(`PDF field did not retain its updated value: ${name}.`)
    }
    if (field.needsAppearancesUpdate()) throw new Error(`PDF field has a stale appearance after editing: ${name}.`)
  }
  const afterDocument = await createDocumentAttachment(bytes, outputName, PDF_MIME_TYPE)
  const after = Object.keys(values).map((name) => describePdfField(requiredPdfField(verifiedFields, name), pdfLibTypes))
  return {
    bytes,
    summary: `Updated ${Object.keys(values).length} interactive PDF field${Object.keys(values).length === 1 ? "" : "s"}; the result remains fillable.`,
    diff: createDocumentDiff(
      outputName,
      `${beforeDocument.extractedText}\n\n[Form fields]\n${before.join("\n")}`,
      `${afterDocument.extractedText}\n\n[Form fields]\n${after.join("\n")}`,
    ),
  }
}

function assertUnsignedPdf(pdf: import("pdf-lib").PDFDocument, pdfLib: typeof import("pdf-lib")) {
  const { PDFDict, PDFArray, PDFName } = pdfLib
  // Parsed objects cover escaped names, compressed objects and direct dictionaries alike.
  // Indirect references are already represented by the context; only direct containers need traversal.
  const pending = pdf.context.enumerateIndirectObjects().map(([, object]) => object)
  const visited = new Set<import("pdf-lib").PDFObject>()
  while (pending.length) {
    const object = pending.pop()
    if (!object || visited.has(object)) continue
    visited.add(object)
    if (object instanceof PDFArray) {
      for (const item of object.asArray()) pending.push(item)
    } else if (object instanceof PDFDict) {
      const type = object.lookup(PDFName.of("Type"))
      const signatureValue =
        object.lookup(PDFName.of("FT")) === PDFName.of("Sig") && object.lookup(PDFName.of("V")) instanceof PDFDict
      const signatureDictionary =
        object.has(PDFName.of("Contents")) &&
        (type === PDFName.of("Sig") || type === PDFName.of("DocTimeStamp") || object.has(PDFName.of("ByteRange")))
      if (signatureValue || signatureDictionary) {
        throw new Error(
          "Signed PDFs cannot be edited because rewriting the file would invalidate its digital signature.",
        )
      }
      for (const value of object.values()) pending.push(value)
    }
  }
}

function setPdfField(field: import("pdf-lib").PDFField, value: string, pdfLib: typeof import("pdf-lib")) {
  if (field.isReadOnly()) throw new Error(`PDF form field is read-only: ${field.getName()}.`)
  if (field instanceof pdfLib.PDFTextField) {
    field.setText(value)
    return
  }
  if (field instanceof pdfLib.PDFCheckBox) {
    const checked = parseCheckboxValue(value, field.getName())
    if (checked) field.check()
    else field.uncheck()
    return
  }
  if (field instanceof pdfLib.PDFRadioGroup) {
    assertPdfOption(field.getName(), value, field.getOptions())
    field.select(value)
    return
  }
  if (field instanceof pdfLib.PDFDropdown || field instanceof pdfLib.PDFOptionList) {
    assertPdfOption(field.getName(), value, field.getOptions())
    field.select(value)
    return
  }
  if (field instanceof pdfLib.PDFSignature) {
    throw new Error(`PDF signature fields cannot be changed: ${field.getName()}.`)
  }
  throw new Error(`Unsupported PDF form field type for ${field.getName()}: ${field.constructor.name}.`)
}

function requiredPdfField(fields: Map<string, import("pdf-lib").PDFField>, name: string) {
  const field = fields.get(name)
  if (!field) throw new Error(`PDF form field not found: ${name}.`)
  return field
}

function parseCheckboxValue(value: string, name: string) {
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`PDF checkbox ${name} expects the string "true" or "false".`)
}

function assertPdfOption(name: string, value: string, options: string[]) {
  if (!options.includes(value)) {
    throw new Error(`PDF field ${name} expects one of: ${options.join(", ") || "(no options)"}.`)
  }
}

function normalizedExpectedPdfValue(
  field: import("pdf-lib").PDFField,
  value: string,
  pdfLib: typeof import("pdf-lib"),
) {
  return field instanceof pdfLib.PDFCheckBox ? String(parseCheckboxValue(value, field.getName())) : value
}

function pdfFieldValue(field: import("pdf-lib").PDFField, pdfLib: typeof import("pdf-lib")) {
  if (field instanceof pdfLib.PDFTextField) return field.getText() ?? ""
  if (field instanceof pdfLib.PDFCheckBox) return String(field.isChecked())
  if (field instanceof pdfLib.PDFRadioGroup) return field.getSelected() ?? ""
  if (field instanceof pdfLib.PDFDropdown || field instanceof pdfLib.PDFOptionList) {
    return field.getSelected().join(", ")
  }
  return ""
}

function describePdfField(field: import("pdf-lib").PDFField, pdfLib: typeof import("pdf-lib")) {
  let type = field.constructor.name.replace(/^PDF/, "")
  let suffix = `value=${JSON.stringify(pdfFieldValue(field, pdfLib))}`
  if (
    field instanceof pdfLib.PDFRadioGroup ||
    field instanceof pdfLib.PDFDropdown ||
    field instanceof pdfLib.PDFOptionList
  ) {
    suffix += ` options=${JSON.stringify(field.getOptions())}`
  }
  if (field.isReadOnly()) suffix += " read-only"
  if (field instanceof pdfLib.PDFSignature) type = "Signature"
  return `${field.getName()} (${type}): ${suffix}`
}

async function resolveDocumentPaths(input: EditDocumentInput, context: ToolContext) {
  const source = await resolveWorkspacePath(input.path, context)
  const file = await stat(source)
  if (!file.isFile()) throw new Error(`${input.path} is not a file.`)
  const extension = extname(source).toLowerCase()
  if (extension !== ".docx" && extension !== ".pdf") {
    throw new Error("edit_document supports workspace DOCX and PDF files only.")
  }
  const target = input.replaceOriginal
    ? source
    : await resolveWorkspacePath(input.outputPath ?? editedDocumentPath(input.path), context, {
        allowMissingLeaf: true,
      })
  if (!input.replaceOriginal && target === source) {
    throw new Error("The edited copy must use a different path. Set replace_original only when explicitly requested.")
  }
  if (extname(target).toLowerCase() !== extension) {
    throw new Error(`The edited document must keep its ${extension} extension.`)
  }
  if (!input.replaceOriginal && (await pathExists(target))) {
    throw new Error(`The output file already exists: ${target}. Choose another output_path.`)
  }
  return { source, target, extension, mode: file.mode & 0o777 }
}

async function readBoundedDocument(path: string) {
  const file = await stat(path)
  if (file.size === 0) throw new Error("The source document is empty.")
  if (file.size > MAX_RAW_DOCUMENT_BYTES) {
    throw new Error(`The source document exceeds the ${MAX_RAW_DOCUMENT_BYTES / 1024 ** 2} MB limit.`)
  }
  return readFile(path)
}

async function assertDocumentUnchanged(path: string, expected: Buffer) {
  const conflict = () =>
    new Error("The source document changed while this edit was being prepared. Read it again before retrying.")
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.size !== expected.length || !(await readFile(path)).equals(expected)) throw conflict()
  } catch (error) {
    if (isNotFoundError(error)) throw conflict()
    throw error
  }
}

async function publishDocument(path: string, bytes: Buffer, mode: number, expectedSource?: Buffer) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let renamed = false
  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" })
    await chmod(temporary, mode)
    if (expectedSource) {
      // Optimistic conflict check immediately before the atomic rename; external editors do not share a lock.
      await assertDocumentUnchanged(path, expectedSource)
      await rename(temporary, path)
      renamed = true
    } else await link(temporary, path)
  } catch (error) {
    if (!expectedSource && isAlreadyExists(error)) throw new Error(`The output file already exists: ${path}.`)
    throw error
  } finally {
    if (!renamed) await rm(temporary, { force: true })
  }
}

async function backupOriginal(source: string, bytes: Buffer, cwd: string, dataDirectory?: string) {
  const root = await realpath(resolve(cwd))
  const local = relative(root, source)
  const workspace = createHash("sha256").update(root).digest("hex").slice(0, 16)
  const revision = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`
  const backup = join(dataDirectory ?? localDataDirectory(), "backups", "documents", workspace, revision, local)
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
  // Back up the exact snapshot used to prepare the edit, never a later version read from disk.
  await writeFile(backup, bytes, { mode: 0o600, flag: "wx" })
  return backup
}

function createDocumentDiff(name: string, before: string, after: string) {
  if (before === after) return undefined
  return createPatch(name, before, after, "original", "edited", {
    context: 3,
    headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
  })
}

function quotedPreview(value: string) {
  const preview = value.length > 120 ? `${value.slice(0, 117)}...` : value
  return JSON.stringify(preview)
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

function isAlreadyExists(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
