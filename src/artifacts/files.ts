import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import mammoth from "mammoth"
import { createDocumentAttachment, MAX_RAW_DOCUMENT_BYTES } from "../inference/documents.js"
import type { DocumentContentPart } from "../inference/types.js"
import { isCanvasArtifact } from "./canvas.js"
import {
  type ArtifactMetadata,
  type ArtifactPayload,
  artifactKindForDocument,
  artifactKindForPath,
  artifactMimeType,
  type WorkspaceArtifactReference,
} from "./types.js"

const MAX_RENDERED_DOCX_CHARS = 4_000_000
const MAX_TEXT_ARTIFACT_BYTES = 2_000_000

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

export async function loadWorkspaceArtifact(
  cwd: string,
  reference: WorkspaceArtifactReference,
  revision: number,
): Promise<ArtifactPayload> {
  const bytes = await readWorkspaceArtifactBytes(cwd, reference)
  return payloadFromBytes(bytes, workspaceArtifactMetadata(reference, revision), reference.path)
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

export async function loadAttachmentArtifact(
  document: DocumentContentPart,
  revision: number,
): Promise<ArtifactPayload> {
  return payloadFromBytes(
    Buffer.from(document.data, "base64"),
    attachmentArtifactMetadata(document, revision),
    document.name,
  )
}

export async function payloadFromBytes(
  bytes: Buffer,
  metadata: ArtifactMetadata,
  name: string,
): Promise<ArtifactPayload> {
  if (bytes.byteLength > MAX_RAW_DOCUMENT_BYTES)
    throw new Error("This file is too large to preview in Canvas.")
  if (metadata.kind === "pdf" || metadata.kind === "docx") {
    // Revalidate a workspace file at preview time; an attached document was validated before it
    // entered the session.
    if (metadata.source !== "attachment")
      await createDocumentAttachment(bytes, name, metadata.mimeType)
    if (metadata.kind === "pdf")
      return { ...metadata, encoding: "base64", content: bytes.toString("base64") }
    const result = await mammoth.convertToHtml({ buffer: bytes })
    if (result.value.length > MAX_RENDERED_DOCX_CHARS)
      throw new Error("This Word document is too large to preview.")
    return { ...metadata, encoding: "html", content: result.value }
  }
  if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES)
    throw new Error("This text file is too large to preview in Canvas.")
  try {
    return {
      ...metadata,
      encoding: "utf8",
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    }
  } catch {
    throw new Error(`${name} is not valid UTF-8 text.`)
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
