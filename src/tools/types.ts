import type { ArtifactPublisher } from "../artifacts/publisher.js"
import type { FileArtifactReference } from "../artifacts/types.js"
import type { AttachmentContentPart } from "../inference/types.js"
import type { SkillCatalog } from "../skills/catalog.js"
import type { ParallelClient } from "../web/client.js"

export const TOOL_NAMES = [
  "web_search",
  "web_read",
  "skill",
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "edit_document",
  "document",
  "save_attachment",
  "publish_artifact",
  "bash",
  "agent",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type DocumentTextReplacement = { old: string; new: string }

export type EditDocumentOperation =
  | { kind: "replace_text"; replacements: DocumentTextReplacement[] }
  | { kind: "fill_pdf_form"; fields: Record<string, string> }

export const DOCUMENT_OPERATIONS = [
  "check",
  "create",
  "inspect-pdf",
  "edit-pdf",
  "convert",
  "render",
] as const
export type DocumentOperation = (typeof DOCUMENT_OPERATIONS)[number]

export type ToolCall =
  | { name: "web_search"; input: { objective: string; searchQueries: string[] } }
  | { name: "web_read"; input: { url: string; objective?: string } }
  | { name: "skill"; input: { skill: string; path?: string } }
  | { name: "read"; input: { path: string; offset?: number; limit?: number } }
  | {
      name: "grep"
      input: { pattern: string; path: string; include?: string; maxResults?: number }
    }
  | { name: "glob"; input: { pattern: string; path: string; maxResults?: number } }
  | { name: "write"; input: { path: string; content: string } }
  | { name: "edit"; input: { path: string; old: string; new: string } }
  | {
      name: "edit_document"
      input: {
        path: string
        outputPath?: string
        replaceOriginal: boolean
        operation: EditDocumentOperation
      }
    }
  | {
      name: "document"
      input: {
        operation: DocumentOperation
        path?: string
        specPath?: string
        outputPath?: string
        pages?: number[]
      }
    }
  | { name: "save_attachment"; input: { attachment: string; path: string } }
  | { name: "publish_artifact"; input: { path: string; artifactId?: string } }
  | { name: "bash"; input: { command: string; timeoutMs?: number } }
  | { name: "agent"; input: { description: string; prompt: string } }

export type ToolResult = {
  title: string
  output: string
  diff?: string
  /** Live workspace file or explicitly published preview copy. */
  artifact?: FileArtifactReference
}

export type ToolContext = {
  cwd?: string
  /**
   * Optional local-data root override for document backups, runtime and bundled skill resources.
   */
  dataDirectory?: string
  artifactPublisher?: ArtifactPublisher
  /** Original session attachments, retained independently of compacted model context. */
  attachments?: () => readonly AttachmentContentPart[]
  /**
   * Canonical file authorized by the permission policy for this publication only. Never
   * model-supplied.
   */
  authorizedArtifactPath?: string
  signal?: AbortSignal
  webClient?: ParallelClient
  webClientModel?: string
  webSession?: { id?: string }
  skills?: SkillCatalog
}
