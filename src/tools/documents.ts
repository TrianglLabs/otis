import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
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
import {
  DOCX_MIME_TYPE,
  MAX_RAW_DOCUMENT_BYTES,
  PDF_MIME_TYPE,
} from "../inference/document-constraints.js"
import { createDocumentAttachment, validateDocxArchive } from "../inference/documents.js"
import { localDataDirectory } from "../local/paths.js"
import type { DocumentTextReplacement, ToolCall, ToolContext, ToolResult } from "./types.js"
import { editedDocumentPath, isNotFoundError, resolveWorkspacePath } from "./workspace.js"

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
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids these C0 controls and lone surrogates.
const INVALID_XML_CHARACTERS = /[\0-\x08\v\f\x0E-\x1F\p{Cs}]/u
const SOURCE_CHANGED =
  "The source document changed while this edit was being prepared. Read it again before retrying."

export async function editLocalDocument(
  input: Extract<ToolCall, { name: "edit_document" }>["input"],
  context: ToolContext,
): Promise<ToolResult> {
  const cwd = context.cwd ?? process.cwd()
  const sourcePath = await resolveWorkspacePath(input.path, context)
  const file = await stat(sourcePath)
  if (!file.isFile()) throw new Error(`${input.path} is not a file.`)
  const extension = extname(sourcePath).toLowerCase()
  if (extension !== ".docx" && extension !== ".pdf")
    throw new Error("edit_document supports workspace DOCX and PDF files only.")
  const target = input.replaceOriginal
    ? sourcePath
    : await resolveWorkspacePath(input.outputPath ?? editedDocumentPath(input.path), context, {
        allowMissingLeaf: true,
      })
  if (extname(target).toLowerCase() !== extension)
    throw new Error(`The edited document must keep its ${extension} extension.`)
  if (!input.replaceOriginal) {
    if (target === sourcePath) {
      throw new Error(
        "The edited copy must use a different path. Set replace_original only when explicitly requested.",
      )
    }
    const existing = await stat(target).catch((error) => {
      if (!isNotFoundError(error)) throw error
    })
    if (existing)
      throw new Error(`The output file already exists: ${target}. Choose another output_path.`)
  }
  context.signal?.throwIfAborted()
  if (file.size === 0) throw new Error("The source document is empty.")
  if (file.size > MAX_RAW_DOCUMENT_BYTES) {
    throw new Error(
      `The source document exceeds the ${MAX_RAW_DOCUMENT_BYTES / 1024 ** 2} MB limit.`,
    )
  }
  const source = await readFile(sourcePath)
  if (extension === ".docx" && input.operation.kind !== "replace_text")
    throw new Error("DOCX editing requires replacements; form_fields are only valid for PDF forms.")
  if (extension === ".pdf" && input.operation.kind !== "fill_pdf_form") {
    throw new Error(
      "PDF text replacements use the document tool's inspect-pdf/edit-pdf operations; load the documents skill for the edit plan. Use form_fields here for an interactive PDF.",
    )
  }
  const prepared =
    input.operation.kind === "replace_text"
      ? await editDocx(source, input.operation.replacements, basename(target))
      : await fillPdfForm(source, input.operation.fields, basename(target))
  context.signal?.throwIfAborted()

  const mode = file.mode & 0o777
  let backup: string | undefined
  if (input.replaceOriginal) {
    await assertDocumentUnchanged(sourcePath, source)
    const root = await realpath(resolve(cwd))
    const workspace = createHash("sha256").update(root).digest("hex").slice(0, 16)
    const revision = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`
    backup = join(
      context.dataDirectory ?? localDataDirectory(),
      "backups",
      "documents",
      workspace,
      revision,
      relative(root, sourcePath),
    )
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
    // Back up the exact snapshot used to prepare the edit, never a later version read from disk.
    await writeFile(backup, source, { mode: 0o600, flag: "wx" })
    try {
      context.signal?.throwIfAborted()
      await publishDocument(target, prepared.bytes, mode, source)
    } catch (error) {
      await rm(backup, { force: true })
      throw error
    }
  } else await publishDocument(target, prepared.bytes, mode)
  const artifact = await workspaceArtifactReference(target, cwd)
  if (!artifact) throw new Error("The edited document is not previewable in Canvas.")
  const disposition = input.replaceOriginal
    ? `Replaced ${artifact.path} after validation. The previous version is backed up at ${backup}.`
    : `Created ${artifact.path}. The original file was not changed.`
  return {
    title: `Edit document: ${target}`,
    output: `${disposition}\n${prepared.summary}`,
    ...(prepared.diff ? { diff: prepared.diff } : {}),
    artifact,
  }
}

export async function inspectPdfForm(bytes: Uint8Array) {
  const pdf = await loadPdf(bytes)
  return pdf.getForm().getFields().map(describePdfField)
}

async function editDocx(source: Buffer, replacements: DocumentTextReplacement[], name: string) {
  const before = await createDocumentAttachment(source, "source.docx", DOCX_MIME_TYPE)
  const zip = await JSZip.loadAsync(source)
  const parts = Object.keys(zip.files)
    .filter((name) => EDITABLE_WORD_PART.test(name))
    .sort()
  if (!parts.includes("word/document.xml"))
    throw new Error("The DOCX is missing its main document part.")

  const documents = new Map<string, XmlDocument>()
  for (const part of parts) {
    const file = zip.file(part)
    if (!file) continue
    const xml = await file.async("string")
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error(`Could not parse ${part}: document type declarations are not allowed.`)
    try {
      const parser = new DOMParser({
        locator: false,
        onError: (_level, message) => {
          throw new Error(message)
        },
      })
      documents.set(part, parser.parseFromString(xml, "application/xml"))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not parse ${part}: ${message}`)
    }
  }
  // Replacements only change text inside existing runs, so the segment structure stays valid.
  const segments = [...documents.values()].flatMap((document) =>
    Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "p")).flatMap(wordTextSegments),
  )

  for (const replacement of replacements) {
    validateWordReplacement(replacement.old, "old")
    validateWordReplacement(replacement.new, "new")
    const matches = segments.flatMap((nodes) => {
      const text = nodes.map((node) => node.textContent ?? "").join("")
      const found: { nodes: XmlElement[]; offset: number }[] = []
      for (
        let offset = text.indexOf(replacement.old);
        offset !== -1;
        offset = text.indexOf(replacement.old, offset + 1)
      ) {
        found.push({ nodes, offset })
      }
      return found
    })
    if (matches.length === 0) {
      const preview =
        replacement.old.length > 120 ? `${replacement.old.slice(0, 117)}...` : replacement.old
      throw new Error(`DOCX text was not found in one paragraph: ${JSON.stringify(preview)}`)
    }
    if (matches.length > 1) {
      throw new Error(
        `DOCX text appears ${matches.length} times; provide a more specific replacement.`,
      )
    }
    // Keep unchanged edges in their original runs so links and character formatting survive
    // local edits.
    const { old: oldText, new: newText } = replacement
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
    const length = oldText.length - prefixLength - suffixLength
    const inserted = newText.slice(prefixLength, newText.length - suffixLength)
    const { nodes } = matches[0]
    const offset = matches[0].offset + prefixLength
    const starts: number[] = []
    let total = 0
    for (const node of nodes) {
      starts.push(total)
      total += (node.textContent ?? "").length
    }
    const runAt = (position: number) =>
      starts.findIndex(
        (start, index) =>
          start <= position && position < start + (nodes[index].textContent ?? "").length,
      )
    // An insertion at a run boundary inherits the preceding run, leaving the following run
    // untouched.
    const first = runAt(length === 0 && offset > 0 ? offset - 1 : offset)
    const last = length === 0 ? first : runAt(offset + length - 1)
    if (first < 0 || last < 0)
      throw new Error("Could not map the DOCX text replacement to its runs.")
    const prefix = (nodes[first].textContent ?? "").slice(0, offset - starts[first])
    const suffix = (nodes[last].textContent ?? "").slice(offset + length - starts[last])
    if (first === last) setWordText(nodes[first], `${prefix}${inserted}${suffix}`)
    else {
      setWordText(nodes[first], `${prefix}${inserted}`)
      for (let index = first + 1; index < last; index += 1) setWordText(nodes[index], "")
      setWordText(nodes[last], suffix)
    }
  }

  const serializer = new XMLSerializer()
  for (const [part, document] of documents) zip.file(part, serializer.serializeToString(document))
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  await validateDocxArchive(bytes)
  const after = await createDocumentAttachment(bytes, name, DOCX_MIME_TYPE)
  return {
    bytes,
    summary: `Applied ${replacements.length} structure-preserving text replacement${replacements.length === 1 ? "" : "s"}.`,
    diff: createDocumentDiff(name, before.extractedText, after.extractedText),
  }
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

function setWordText(node: XmlElement, value: string) {
  node.textContent = value
  if (/^\s|\s$/.test(value)) node.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve")
  else node.removeAttributeNS(XML_NAMESPACE, "space")
}

function validateWordReplacement(value: string, label: string) {
  if (/[\r\n\t]/.test(value)) {
    throw new Error(
      `DOCX replacement ${label} text must stay within one paragraph and cannot contain tabs.`,
    )
  }
  if (INVALID_XML_CHARACTERS.test(value)) {
    throw new Error(`DOCX replacement ${label} text contains characters that are not valid in XML.`)
  }
}

let pdfLib: typeof import("pdf-lib")

async function loadPdf(bytes: Uint8Array) {
  pdfLib ??= await import("pdf-lib")
  return pdfLib.PDFDocument.load(bytes, { updateMetadata: false })
}

async function fillPdfForm(source: Buffer, values: Record<string, string>, name: string) {
  const beforeDocument = await createDocumentAttachment(source, "source.pdf", PDF_MIME_TYPE)
  const pdf = await loadPdf(source)
  const { PDFDict, PDFArray, PDFName } = pdfLib
  // Parsed objects cover escaped names, compressed objects and direct dictionaries alike.
  // Indirect references are already represented by the context; only direct containers need
  // traversal.
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
        object.lookup(PDFName.of("FT")) === PDFName.of("Sig") &&
        object.lookup(PDFName.of("V")) instanceof PDFDict
      const signatureDictionary =
        object.has(PDFName.of("Contents")) &&
        (type === PDFName.of("Sig") ||
          type === PDFName.of("DocTimeStamp") ||
          object.has(PDFName.of("ByteRange")))
      if (signatureValue || signatureDictionary) {
        throw new Error(
          "Signed PDFs cannot be edited because rewriting the file would invalidate its digital signature.",
        )
      }
      for (const value of object.values()) pending.push(value)
    }
  }
  const form = pdf.getForm()
  if (form.hasXFA())
    throw new Error(
      "XFA-based PDF forms are not supported because they cannot be updated reliably.",
    )
  const fields = new Map(form.getFields().map((field) => [field.getName(), field]))
  if (fields.size === 0) {
    throw new Error(
      "This PDF has no interactive form fields. Edit its source document and export a new PDF instead.",
    )
  }
  const missing = Object.keys(values).filter((name) => !fields.has(name))
  if (missing.length > 0) {
    throw new Error(
      `PDF form field${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}.`,
    )
  }

  const before = Object.keys(values).map((name) => describePdfField(requiredPdfField(fields, name)))
  for (const [name, value] of Object.entries(values)) {
    const field = requiredPdfField(fields, name)
    if (field.isReadOnly()) throw new Error(`PDF form field is read-only: ${name}.`)
    if (field instanceof pdfLib.PDFTextField) field.setText(value)
    else if (field instanceof pdfLib.PDFCheckBox) {
      if (parseCheckboxValue(value, name)) field.check()
      else field.uncheck()
    } else if (
      field instanceof pdfLib.PDFRadioGroup ||
      field instanceof pdfLib.PDFDropdown ||
      field instanceof pdfLib.PDFOptionList
    ) {
      const options = field.getOptions()
      if (!options.includes(value))
        throw new Error(
          `PDF field ${name} expects one of: ${options.join(", ") || "(no options)"}.`,
        )
      field.select(value)
    } else if (field instanceof pdfLib.PDFSignature)
      throw new Error(`PDF signature fields cannot be changed: ${name}.`)
    else throw new Error(`Unsupported PDF form field type for ${name}: ${field.constructor.name}.`)
  }
  form.updateFieldAppearances()
  const bytes = Buffer.from(await pdf.save())

  const verified = await loadPdf(bytes)
  const verifiedFields = new Map(
    verified
      .getForm()
      .getFields()
      .map((field) => [field.getName(), field]),
  )
  const after: string[] = []
  for (const [name, expected] of Object.entries(values)) {
    const field = verifiedFields.get(name)
    const normalized =
      field instanceof pdfLib.PDFCheckBox ? String(parseCheckboxValue(expected, name)) : expected
    if (!field || pdfFieldValue(field) !== normalized)
      throw new Error(`PDF field did not retain its updated value: ${name}.`)
    if (field.needsAppearancesUpdate())
      throw new Error(`PDF field has a stale appearance after editing: ${name}.`)
    after.push(describePdfField(field))
  }
  const afterDocument = await createDocumentAttachment(bytes, name, PDF_MIME_TYPE)
  return {
    bytes,
    summary: `Updated ${Object.keys(values).length} interactive PDF field${Object.keys(values).length === 1 ? "" : "s"}; the result remains fillable.`,
    diff: createDocumentDiff(
      name,
      `${beforeDocument.extractedText}\n\n[Form fields]\n${before.join("\n")}`,
      `${afterDocument.extractedText}\n\n[Form fields]\n${after.join("\n")}`,
    ),
  }
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

function pdfFieldValue(field: import("pdf-lib").PDFField) {
  if (field instanceof pdfLib.PDFTextField) return field.getText() ?? ""
  if (field instanceof pdfLib.PDFCheckBox) return String(field.isChecked())
  if (field instanceof pdfLib.PDFRadioGroup) return field.getSelected() ?? ""
  if (field instanceof pdfLib.PDFDropdown || field instanceof pdfLib.PDFOptionList) {
    return field.getSelected().join(", ")
  }
  return ""
}

function describePdfField(field: import("pdf-lib").PDFField) {
  let type = field.constructor.name.replace(/^PDF/, "")
  let suffix = `value=${JSON.stringify(pdfFieldValue(field))}`
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

async function assertDocumentUnchanged(path: string, expected: Buffer) {
  try {
    const file = await lstat(path)
    if (file.isFile() && file.size === expected.length && (await readFile(path)).equals(expected))
      return
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  throw new Error(SOURCE_CHANGED)
}

async function publishDocument(path: string, bytes: Buffer, mode: number, expectedSource?: Buffer) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let renamed = false
  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" })
    await chmod(temporary, mode)
    if (expectedSource) {
      // Optimistic conflict check immediately before the atomic rename; external editors do not
      // share a lock.
      await assertDocumentUnchanged(path, expectedSource)
      await rename(temporary, path)
      renamed = true
    } else await link(temporary, path)
  } catch (error) {
    if (!expectedSource && error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`The output file already exists: ${path}.`)
    throw error
  } finally {
    if (!renamed) await rm(temporary, { force: true })
  }
}

function createDocumentDiff(name: string, before: string, after: string) {
  if (before === after) return undefined
  return createPatch(name, before, after, "original", "edited", {
    context: 3,
    headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
  })
}
