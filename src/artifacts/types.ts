import { basename, extname, isAbsolute } from "node:path"

export const ARTIFACT_KINDS = ["markdown", "text", "html", "pdf", "docx"] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** A previewable file produced or opened by a workspace tool. Paths stay workspace-relative across session moves. */
export type WorkspaceArtifactReference = {
  source: "workspace"
  path: string
  kind: ArtifactKind
}

/** A persisted document attachment address. The content stays in the session message, never in renderer state. */
export type AttachmentArtifactReference = {
  source: "attachment"
  sha256: string
  name: string
  kind: ArtifactKind
  mimeType: string
}

export type ArtifactReference = WorkspaceArtifactReference | AttachmentArtifactReference

/** Small identity sent with application state. File contents travel only when the renderer asks for this revision. */
export type ArtifactMetadata = {
  id: string
  revision: number
  source: "workspace" | "attachment"
  kind: ArtifactKind
  title: string
  mimeType: string
  editable: boolean
  path?: string
}

export type ArtifactPayload = ArtifactMetadata & {
  encoding: "utf8" | "base64" | "html"
  content: string
}

const FILE_KINDS = new Map<string, ArtifactKind>([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
  [".html", "html"],
  [".htm", "html"],
  [".pdf", "pdf"],
  [".docx", "docx"],
])

const MIME_TYPES: Record<ArtifactKind, string> = {
  markdown: "text/markdown",
  text: "text/plain",
  html: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

export function artifactKindForPath(path: string): ArtifactKind | undefined {
  return FILE_KINDS.get(extname(path).toLowerCase())
}

export function artifactKindForDocument(name: string, kind: "text" | "pdf" | "docx", mimeType: string): ArtifactKind {
  if (kind !== "text") return kind
  if (mimeType === "text/markdown" || [".md", ".markdown"].includes(extname(name).toLowerCase())) return "markdown"
  if (mimeType === "text/html" || [".html", ".htm"].includes(extname(name).toLowerCase())) return "html"
  return "text"
}

export function artifactMimeType(kind: ArtifactKind) {
  return MIME_TYPES[kind]
}

export function isEditableArtifact(kind: ArtifactKind) {
  return kind === "markdown" || kind === "text" || kind === "html"
}

export function isWorkspaceArtifactReference(value: unknown): value is WorkspaceArtifactReference {
  if (!isRecord(value) || value.source !== "workspace" || typeof value.path !== "string") return false
  if (!ARTIFACT_KINDS.includes(value.kind as ArtifactKind)) return false
  const path = value.path.replaceAll("\\", "/")
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === "..")) return false
  return artifactKindForPath(path) === value.kind
}

export function attachmentArtifactReference(document: {
  sha256: string
  name: string
  kind: "text" | "pdf" | "docx"
  mimeType: string
}): AttachmentArtifactReference {
  return {
    source: "attachment",
    sha256: document.sha256,
    name: document.name,
    kind: artifactKindForDocument(document.name, document.kind, document.mimeType),
    mimeType: document.mimeType,
  }
}

export function isAttachmentArtifactReference(value: unknown): value is AttachmentArtifactReference {
  if (!isRecord(value) || value.source !== "attachment") return false
  if (typeof value.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(value.sha256)) return false
  if (typeof value.name !== "string" || !value.name || typeof value.mimeType !== "string") return false
  if (!ARTIFACT_KINDS.includes(value.kind as ArtifactKind)) return false
  return (
    artifactKindForDocument(
      value.name,
      value.kind === "pdf" || value.kind === "docx" ? value.kind : "text",
      value.mimeType,
    ) === value.kind
  )
}

export function isArtifactReference(value: unknown): value is ArtifactReference {
  return isWorkspaceArtifactReference(value) || isAttachmentArtifactReference(value)
}

export function artifactTitle(path: string) {
  return basename(path) || path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
