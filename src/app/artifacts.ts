import {
  attachmentArtifactMetadata,
  loadAttachmentArtifact,
  loadWorkspaceArtifact,
  workspaceArtifactMetadata,
} from "../artifacts/files.js"
import {
  type ArtifactMetadata,
  type ArtifactPayload,
  type ArtifactReference,
  attachmentArtifactReference,
  isWorkspaceArtifactReference,
  type WorkspaceArtifactReference,
} from "../artifacts/types.js"
import type { ChatMessage, DocumentContentPart, UserChatMessage } from "../inference/types.js"
import type { SessionToolActivity } from "../storage/index.js"

type ActiveArtifact =
  | { source: "workspace"; reference: WorkspaceArtifactReference }
  | { source: "attachment"; document: DocumentContentPart }

/** Session-scoped artifact selection shared by terminal, headless, and graphical adapters. */
export class ArtifactStore {
  #active: ActiveArtifact | undefined
  #revision = 0
  #attachments = new Map<string, DocumentContentPart>()

  constructor(private readonly cwd: string) {}

  get metadata(): ArtifactMetadata | undefined {
    if (!this.#active) return undefined
    return this.#active.source === "workspace"
      ? workspaceArtifactMetadata(this.#active.reference, this.#revision)
      : attachmentArtifactMetadata(this.#active.document, this.#revision)
  }

  openWorkspace(reference: WorkspaceArtifactReference) {
    if (!isWorkspaceArtifactReference(reference)) throw new Error("Invalid workspace artifact reference.")
    this.#active = { source: "workspace", reference }
    this.#revision += 1
  }

  openAttachment(document: DocumentContentPart) {
    this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    this.#active = { source: "attachment", document }
    this.#revision += 1
  }

  observeMessage(message: UserChatMessage) {
    if (typeof message.content === "string") return
    const documents = message.content.filter((part): part is DocumentContentPart => part.type === "document")
    for (const document of documents) {
      this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    }
    const document = documents.at(-1)
    if (!document) return
    this.openAttachment(document)
  }

  clear() {
    this.#active = undefined
    this.#attachments.clear()
    this.#revision += 1
  }

  /** Restore whichever document attachment or workspace artifact was opened last in transcript order. */
  restore(messages: readonly ChatMessage[], activities: readonly SessionToolActivity[]) {
    this.clear()
    const byCall = groupActivities(activities)
    for (const message of messages) {
      if (message.role === "user") this.observeMessage(message)
      if (message.role !== "assistant") continue
      for (const part of message.content) {
        if (part.type !== "tool_call") continue
        const activity = byCall.get(part.toolCall.id)?.shift()
        if (activity?.artifact) this.openWorkspace(activity.artifact)
      }
    }
  }

  /** Attachments belong to the full session, independent of the model's compacted context. */
  open(reference: ArtifactReference) {
    if (reference.source === "workspace") {
      this.openWorkspace(reference)
      return true
    }
    const document = this.#attachments.get(attachmentKey(reference))
    if (!document) return false
    this.openAttachment(document)
    return true
  }

  /** A stale renderer request gets no payload; its newer status event will request the current revision. */
  async load(revision: number): Promise<ArtifactPayload | undefined> {
    const active = this.#active
    if (!active || revision !== this.#revision) return undefined
    return active.source === "workspace"
      ? loadWorkspaceArtifact(this.cwd, active.reference, revision)
      : loadAttachmentArtifact(active.document, revision)
  }
}

function attachmentKey(reference: ReturnType<typeof attachmentArtifactReference>) {
  return JSON.stringify([reference.sha256, reference.name, reference.kind, reference.mimeType])
}

function groupActivities(activities: readonly SessionToolActivity[]) {
  const grouped = new Map<string, SessionToolActivity[]>()
  for (const activity of activities) {
    const matching = grouped.get(activity.toolCallId) ?? []
    matching.push(activity)
    grouped.set(activity.toolCallId, matching)
  }
  return grouped
}
