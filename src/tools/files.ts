import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname } from "node:path"
import { createPatch } from "diff"
import { workspaceArtifactReference } from "../artifacts/files.js"
import { createDocumentAttachment, MAX_EXTRACTED_DOCUMENT_CHARS } from "../inference/documents.js"
import { detectImageMimeType } from "../inference/images.js"
import { inspectPdfForm } from "./documents.js"
import type { ToolContext, ToolResult } from "./types.js"
import { isNotFoundError, resolveWorkspacePath } from "./workspace.js"

/** Unified diffs without jsdiff's decorative Index/underline header lines. */
const PATCH_OPTIONS = {
  context: 3,
  headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
}
const DEFAULT_READ_LIMIT = 2_000
const MAX_LINE_LENGTH = 2_000
const BINARY_CHECK_BYTES = 8_000

export async function readLocalFile(
  path: string,
  offset = 1,
  limit = DEFAULT_READ_LIMIT,
  context: ToolContext,
): Promise<ToolResult> {
  const filePath = await resolveWorkspacePath(path, context)
  const fileStat = await stat(filePath)

  if (fileStat.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true })
    const output = entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n")
    return { title: `Read directory: ${filePath}`, output: output || "Directory is empty." }
  }

  const content = await readFile(filePath)
  if (detectImageMimeType(content)) {
    throw new Error("read supports text files only. Attach the image to an Otis prompt instead.")
  }
  const extension = extname(filePath).toLowerCase()
  const document =
    extension === ".pdf" || extension === ".docx"
      ? await createDocumentAttachment(content, basename(filePath))
      : undefined
  const pdfForm = extension === ".pdf" ? await inspectPdfForm(content).catch(() => []) : []
  if (!document && isBinary(content)) throw new Error("read supports UTF-8 text, PDF, and DOCX files only.")
  const lines = (document?.extractedText ?? content.toString("utf8")).split(/\r?\n/)
  const start = Math.max(1, Math.floor(offset))
  const count = Math.max(1, Math.min(DEFAULT_READ_LIMIT, Math.floor(limit)))
  const output = lines
    .slice(start - 1, start - 1 + count)
    .map((line, index) => `${start + index}: ${truncateLine(line)}`)
    .join("\n")
  const artifact = await workspaceArtifactReference(filePath, context.cwd ?? process.cwd())
  const notice = document?.truncated
    ? `\n\n[Document extraction stopped at ${MAX_EXTRACTED_DOCUMENT_CHARS} characters. The remaining source content is not available through read; later offsets cannot retrieve it.]`
    : ""
  const formNotice =
    pdfForm.length > 0 ? `\n\n[Interactive PDF form fields]\n${pdfForm.map((field) => `- ${field}`).join("\n")}` : ""
  return {
    title: `Read: ${filePath}`,
    output: (output || (start > 1 ? "No lines at this offset." : "File is empty.")) + notice + formNotice,
    ...(artifact ? { artifact } : {}),
  }
}

export async function writeLocalFile(path: string, content: string, context: ToolContext): Promise<ToolResult> {
  const filePath = await resolveWorkspacePath(path, context, { allowMissingLeaf: true })
  assertTextFilePath(filePath)
  let diff: string

  try {
    const existing = editableText(await readFile(filePath), filePath)
    diff = existing === content ? "" : createPatch(filePath, existing, content, "", "", PATCH_OPTIONS)
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    diff = createPatch(filePath, "", content, "", "", PATCH_OPTIONS)
  }

  await writeFile(filePath, content, "utf8")
  const artifact = await workspaceArtifactReference(filePath, context.cwd ?? process.cwd())
  return {
    title: `Write: ${filePath}`,
    output: `Wrote ${content.length} characters.`,
    ...(diff ? { diff } : {}),
    ...(artifact ? { artifact } : {}),
  }
}

export async function editLocalFile(
  path: string,
  oldText: string,
  newText: string,
  context: ToolContext,
): Promise<ToolResult> {
  if (!oldText) throw new Error("edit requires a non-empty old string")

  const filePath = await resolveWorkspacePath(path, context)
  assertTextFilePath(filePath)
  const content = editableText(await readFile(filePath), filePath)
  const first = content.indexOf(oldText)
  if (first === -1) throw new Error("old string was not found")
  if (content.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("old string appears multiple times; provide a more specific old string")
  }

  const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`
  await writeFile(filePath, updated, "utf8")
  const artifact = await workspaceArtifactReference(filePath, context.cwd ?? process.cwd())
  return {
    title: `Edit: ${filePath}`,
    output: `Replaced ${oldText.length} characters with ${newText.length} characters.`,
    diff: createPatch(filePath, content, updated, "", "", PATCH_OPTIONS),
    ...(artifact ? { artifact } : {}),
  }
}

export function truncateLine(line: string) {
  return line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)} [line truncated]`
}

function assertTextFilePath(path: string) {
  if ([".pdf", ".docx", ".doc"].includes(extname(path).toLowerCase())) {
    throw new Error("write and edit support UTF-8 text only. PDF and Word files require a format-aware editor.")
  }
}

function editableText(bytes: Buffer, path: string) {
  const prefix = bytes.subarray(0, 1024).toString("latin1")
  if (bytes.includes(0) || prefix.trimStart().startsWith("%PDF-") || detectImageMimeType(bytes)) {
    throw new Error(`${path} is a binary file; write and edit support UTF-8 text only.`)
  }
  try {
    // Preserve a BOM, if present, when replacing a substring in a text file.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error(`${path} is not valid UTF-8 text; refusing to overwrite it.`)
  }
}

export function isBinary(buffer: Buffer) {
  return buffer.subarray(0, Math.min(buffer.length, BINARY_CHECK_BYTES)).includes(0)
}
