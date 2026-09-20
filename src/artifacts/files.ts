import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import mammoth from "mammoth"
import { createDocumentAttachment, MAX_RAW_DOCUMENT_BYTES } from "../inference/documents.js"
import type { DocumentContentPart } from "../inference/types.js"
import { readArtifactBytes } from "./bytes.js"
import { isCanvasArtifact } from "./canvas.js"
import {
  type ArtifactMetadata,
  type ArtifactPayload,
  artifactKindForDocument,
  artifactKindForPath,
  artifactMimeType,
  artifactTitle,
  isEditableArtifact,
  type WorkspaceArtifactReference,
} from "./types.js"

const MAX_RENDERED_DOCX_CHARS = 4_000_000
const MAX_TEXT_ARTIFACT_BYTES = 2_000_000

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

export function workspaceArtifactMetadata(reference: WorkspaceArtifactReference, revision: number): ArtifactMetadata {
  return {
    id: `workspace:${reference.path}`,
    revision,
    source: "workspace",
    kind: reference.kind,
    title: artifactTitle(reference.path),
    mimeType: artifactMimeType(reference.kind),
    editable: isEditableArtifact(reference.kind),
    path: reference.path,
  }
}

export function attachmentArtifactMetadata(document: DocumentContentPart, revision: number): ArtifactMetadata {
  const kind = artifactKindForDocument(document.name, document.kind, document.mimeType)
  return {
    id: `attachment:${document.sha256}`,
    revision,
    source: "attachment",
    kind,
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

export async function readWorkspaceArtifactBytes(cwd: string, reference: WorkspaceArtifactReference) {
  const root = await realpath(resolve(cwd))
  try {
    const path = await realpath(resolve(root, reference.path))
    const nestedPath = relative(root, path)
    if (!isNestedPath(nestedPath)) throw new Error(`Artifact is outside the workspace: ${reference.path}`)
    return await readArtifactBytes(path)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
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
  if (bytes.byteLength > MAX_RAW_DOCUMENT_BYTES) throw new Error("This file is too large to preview in Canvas.")
  if (metadata.kind === "pdf") {
    // Revalidate a workspace file at preview time; an attached document was validated before it entered the session.
    if (metadata.source !== "attachment") await createDocumentAttachment(bytes, name, metadata.mimeType)
    return { ...metadata, encoding: "base64", content: bytes.toString("base64") }
  }
  if (metadata.kind === "docx") {
    if (metadata.source !== "attachment") await createDocumentAttachment(bytes, name, metadata.mimeType)
    const result = await mammoth.convertToHtml({ buffer: bytes })
    if (result.value.length > MAX_RENDERED_DOCX_CHARS) throw new Error("This Word document is too large to preview.")
    return { ...metadata, encoding: "html", content: result.value }
  }
  if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES) throw new Error("This text file is too large to preview in Canvas.")
  return { ...metadata, encoding: "utf8", content: decodeUtf8(bytes, name) }
}

function decodeUtf8(bytes: Uint8Array, name: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${name} is not valid UTF-8 text.`)
  }
}
