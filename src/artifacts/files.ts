import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import mammoth from "mammoth"
import { MAX_PDF_PAGES } from "../inference/document-constraints.js"
import {
  createDocumentAttachment,
  MAX_RAW_DOCUMENT_BYTES,
  validateDocxArchive,
} from "../inference/documents.js"
import type { DocumentContentPart } from "../inference/types.js"
import { isCanvasArtifact } from "./canvas.js"
import {
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactPayload,
  artifactKindForDocument,
  artifactKindForPath,
  artifactMimeType,
  type WorkspaceArtifactReference,
} from "./types.js"

const MAX_RENDERED_DOCX_CHARS = 4_000_000
/** The store and export cap for text artifacts; Markdown previews render a smaller subset. */
const MAX_TEXT_ARTIFACT_BYTES = 2_000_000
export const MAX_MARKDOWN_PREVIEW_BYTES = 512 * 1024

/**
 * Bound reads even if the source grows, and refuse directories, devices, and final-component
 * symlinks.
 */
export async function readArtifactBytes(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const file = await handle.stat()
    if (!file.isFile()) throw new Error("Only regular files can be read as artifacts.")
    if (file.size > MAX_RAW_DOCUMENT_BYTES)
      throw new Error("This file is too large to preview in Canvas.")
    const bytes = Buffer.alloc(file.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== file.size || after.size !== file.size || after.mtimeMs !== file.mtimeMs) {
      throw new Error("The file changed while being read. Try again once writing has finished.")
    }
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export async function workspaceArtifactReference(
  filePath: string,
  cwd: string,
): Promise<WorkspaceArtifactReference | undefined> {
  const kind = artifactKindForPath(filePath)
  if (!kind || !isCanvasArtifact(kind)) return undefined
  const root = await realpath(resolve(cwd))
  const path = relative(root, filePath).replaceAll("\\", "/")
  if (!isNestedPath(path)) throw new Error(`Artifact is outside the workspace: ${filePath}`)
  return { source: "workspace", path, kind }
}

export function workspaceArtifactMetadata(
  reference: WorkspaceArtifactReference,
  revision: number,
): ArtifactMetadata {
  const { path, kind } = reference
  return {
    id: `workspace:${path}`,
    revision,
    source: "workspace",
    kind,
    title: basename(path) || path,
    mimeType: artifactMimeType(kind),
    editable: kind === "markdown" || kind === "text" || kind === "html",
    path,
  }
}

export function attachmentArtifactMetadata(
  document: DocumentContentPart,
  revision: number,
): ArtifactMetadata {
  return {
    id: `attachment:${document.sha256}`,
    revision,
    source: "attachment",
    kind: artifactKindForDocument(document.name, document.kind, document.mimeType),
    title: document.name,
    mimeType: document.mimeType,
    editable: false,
  }
}

export async function readWorkspaceArtifactBytes(
  cwd: string,
  reference: WorkspaceArtifactReference,
) {
  const root = await realpath(resolve(cwd))
  try {
    const path = await realpath(resolve(root, reference.path))
    if (!isNestedPath(relative(root, path)))
      throw new Error(`Artifact is outside the workspace: ${reference.path}`)
    return await readArtifactBytes(path)
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(
        `This working file is no longer at ${reference.path}. It may have been moved or deleted. Ask Otis to publish the file from its current location.`,
      )
    }
    throw error
  }
}

function isNestedPath(path: string) {
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/**
 * Preview-time conversion checks only what the renderer needs: the PDF header and page count, the
 * DOCX archive bounds, and the text caps. Publication runs the full document validation.
 */
export async function payloadFromBytes(
  bytes: Buffer,
  metadata: ArtifactMetadata,
  name: string,
): Promise<ArtifactPayload> {
  if (bytes.byteLength > MAX_RAW_DOCUMENT_BYTES)
    throw new Error("This file is too large to preview in Canvas.")
  const { kind } = metadata
  if (kind === "pdf") {
    if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-"))
      throw new Error(`${name} is not a PDF file.`)
    const pages = await pdfPageCount(bytes)
    if (pages > MAX_PDF_PAGES)
      throw new Error(`PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES}.`)
    // A tight copy: the renderer receives exactly these bytes, never a shared pool slab.
    return { ...metadata, kind, encoding: "bytes", content: new Uint8Array(bytes) }
  }
  if (kind === "docx") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${name} is not a DOCX file.`)
    await validateDocxArchive(bytes)
    const result = await mammoth.convertToHtml({ buffer: bytes })
    if (result.value.length > MAX_RENDERED_DOCX_CHARS)
      throw new Error("This Word document is too large to preview.")
    return { ...metadata, kind, encoding: "html", content: result.value }
  }
  if (kind === "markdown" && bytes.byteLength > MAX_MARKDOWN_PREVIEW_BYTES)
    throw new Error(
      "This Markdown file is too large to preview in Canvas. Save a copy to open it elsewhere.",
    )
  return { ...metadata, kind, encoding: "utf8", content: decodeArtifactText(bytes, name) }
}

/** Full validation before a publication is persisted or advertised as successful. */
export async function validateArtifactBytes(bytes: Buffer, kind: ArtifactKind, name: string) {
  if (kind === "pdf" || kind === "docx") {
    await createDocumentAttachment(bytes, name, artifactMimeType(kind))
    return
  }
  decodeArtifactText(bytes, name)
}

function decodeArtifactText(bytes: Buffer, name: string) {
  if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES)
    throw new Error("This text file is too large to preview in Canvas.")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${name} is not valid UTF-8 text.`)
  }
}

async function pdfPageCount(bytes: Buffer) {
  // PDF.js's worker module registers its own in-process handler; see createDocumentAttachment.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loading = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true })
  try {
    return (await loading.promise).numPages
  } finally {
    await loading.destroy()
  }
}

/**
 * Resolve both names for permission matching; an external symlink requires external-file
 * approval.
 */
export async function resolveArtifactSource(path: string, cwd: string) {
  const workspace = resolve(cwd)
  const root = await realpath(workspace)
  const requested = resolve(workspace, path)
  const canonical = await realpath(requested)
  const resource = (absolute: string, base: string) => {
    const local = relative(base, absolute)
    return (isOutside(local) ? absolute : local || ".").split(sep).join("/")
  }
  return {
    path: canonical,
    external: isOutside(relative(root, canonical)),
    resources: [...new Set([resource(requested, workspace), resource(canonical, root)])],
  }
}

function isOutside(path: string) {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
}
