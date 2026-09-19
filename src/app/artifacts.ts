import { unwatchFile, watchFile } from "node:fs"
import { resolve } from "node:path"
import {
  attachmentArtifactMetadata,
  loadAttachmentArtifact,
  loadWorkspaceArtifact,
  workspaceArtifactMetadata,
} from "../artifacts/files.js"
import { loadPublishedArtifact, publishedArtifactMetadata } from "../artifacts/published.js"
import {
  type ArtifactMetadata,
  type ArtifactPayload,
  type ArtifactReference,
  attachmentArtifactReference,
  type FileArtifactReference,
  isFileArtifactReference,
  isWorkspaceArtifactReference,
  type PublishedArtifactReference,
  type WorkspaceArtifactReference,
} from "../artifacts/types.js"
import type { ChatMessage, DocumentContentPart, UserChatMessage } from "../inference/types.js"
import type { SessionToolActivity } from "../storage/index.js"

type ActiveArtifact =
  | { source: "workspace"; reference: WorkspaceArtifactReference }
  | { source: "attachment"; document: DocumentContentPart }
  | { source: "published"; artifactId: string; version?: number }

/** Session-scoped identities and selection. Adapters receive metadata, not document bytes. */
export class ArtifactStore {
  #active: ActiveArtifact | undefined
  #revision = 0
  #attachments = new Map<string, DocumentContentPart>()
  #published = new Map<string, PublishedArtifactReference[]>()
  #listeners = new Set<() => void>()
  #stopWatching: (() => void) | undefined
  #watchedPath: string | undefined

  constructor(
    private readonly cwd: string,
    private directory?: string,
  ) {}

  get metadata(): ArtifactMetadata | undefined {
    const active = this.#active
    if (!active) return undefined
    if (active.source === "published") {
      const reference = this.#selectedPublished(active)
      if (!reference) return undefined
      return {
        ...publishedArtifactMetadata(reference, this.#revision),
        publication: {
          reference,
          versions: (this.#published.get(active.artifactId) ?? []).map((item) => item.version),
          followingLatest: active.version === undefined,
        },
      }
    }
    return active.source === "workspace"
      ? workspaceArtifactMetadata(active.reference, this.#revision)
      : attachmentArtifactMetadata(active.document, this.#revision)
  }

  setDirectory(directory: string) {
    if (this.directory === directory) return
    this.directory = directory
    this.#published.clear()
    if (this.#active?.source === "published") this.#active = undefined
    this.#changed()
  }

  /** Watching is needed only while a UI subscribes. CLI/headless runs do not start background watchers. */
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    this.#syncWatcher()
    return () => {
      this.#listeners.delete(listener)
      this.#syncWatcher()
    }
  }

  openWorkspace(reference: WorkspaceArtifactReference) {
    if (!isWorkspaceArtifactReference(reference)) throw new Error("Invalid workspace artifact reference.")
    this.#active = { source: "workspace", reference }
    this.#changed()
  }

  /** Register trusted tool results. Background reads do not replace the document the user is viewing. */
  observeFile(reference: FileArtifactReference) {
    if (!isFileArtifactReference(reference)) throw new Error("Invalid file artifact reference.")
    if (reference.source === "workspace") {
      if (!this.#active || (this.#active.source === "workspace" && this.#active.reference.path === reference.path)) {
        this.openWorkspace(reference)
      }
      return
    }
    const versions = this.#published.get(reference.artifactId) ?? []
    const existing = versions.find((item) => item.version === reference.version)
    if (existing && !samePublication(existing, reference)) throw new Error("Conflicting artifact revision in session.")
    if (!existing)
      this.#published.set(
        reference.artifactId,
        [...versions, reference].sort((a, b) => a.version - b.version),
      )
    // Preserve an explicitly selected older revision; otherwise the open artifact follows its latest version.
    if (!this.#active || this.#active.source === "workspace") {
      this.#active = { source: "published", artifactId: reference.artifactId }
    }
    this.#changed()
  }

  openAttachment(document: DocumentContentPart) {
    this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    this.#active = { source: "attachment", document }
    this.#changed()
  }

  observeMessage(message: UserChatMessage) {
    if (typeof message.content === "string") return
    const documents = message.content.filter((part): part is DocumentContentPart => part.type === "document")
    for (const document of documents)
      this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    const document = documents.at(-1)
    if (document) this.openAttachment(document)
  }

  clear() {
    this.#active = undefined
    this.#attachments.clear()
    this.#published.clear()
    this.directory = undefined
    this.#changed()
  }

  /** Full scrollback owns artifact history, independent of compaction of model context. */
  restore(messages: readonly ChatMessage[], activities: readonly SessionToolActivity[], directory = this.directory) {
    this.clear()
    this.directory = directory
    const byCall = groupActivities(activities)
    for (const message of messages) {
      if (message.role === "user") this.observeMessage(message)
      if (message.role !== "assistant") continue
      for (const part of message.content) {
        if (part.type !== "tool_call") continue
        const activity = byCall.get(part.toolCall.id)?.shift()
        if (!activity?.artifact) continue
        this.observeFile(activity.artifact)
        this.open(activity.artifact)
      }
    }
  }

  /** Card clicks follow latest; version navigation explicitly pins a saved revision. */
  open(reference: ArtifactReference, version?: number) {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 || reference.source !== "published"))
      return false
    if (reference.source === "published") {
      const versions = this.#published.get(reference.artifactId)
      if (!versions?.some((item) => samePublication(item, reference))) return false
      if (version !== undefined && !versions.some((item) => item.version === version)) return false
      this.#active = { source: "published", artifactId: reference.artifactId, version }
      this.#changed()
      return true
    }
    if (reference.source === "workspace") {
      this.openWorkspace(reference)
      return true
    }
    const document = this.#attachments.get(attachmentKey(reference))
    if (!document) return false
    this.openAttachment(document)
    return true
  }

  async load(revision: number): Promise<ArtifactPayload | undefined> {
    const active = this.#active
    if (!active || revision !== this.#revision) return undefined
    let payload: ArtifactPayload
    if (active.source === "published") {
      const reference = this.#selectedPublished(active)
      if (!reference || !this.directory) return undefined
      payload = await loadPublishedArtifact(reference, revision, this.directory)
    } else {
      payload = await (active.source === "workspace"
        ? loadWorkspaceArtifact(this.cwd, active.reference, revision)
        : loadAttachmentArtifact(active.document, revision))
    }
    return revision === this.#revision ? payload : undefined
  }

  dispose() {
    this.#listeners.clear()
    this.clear()
  }

  #selectedPublished(active: Extract<ActiveArtifact, { source: "published" }>) {
    const versions = this.#published.get(active.artifactId)
    return active.version === undefined ? versions?.at(-1) : versions?.find((item) => item.version === active.version)
  }

  #changed() {
    this.#revision += 1
    this.#syncWatcher()
    for (const listener of this.#listeners) listener()
  }

  #syncWatcher() {
    const path =
      this.#listeners.size > 0 && this.#active?.source === "workspace"
        ? resolve(this.cwd, this.#active.reference.path)
        : undefined
    if (path === this.#watchedPath) return
    this.#stopWatching?.()
    this.#stopWatching = undefined
    this.#watchedPath = path
    if (!path) return
    const changed = () => {
      if (this.#watchedPath === path) this.#changed()
    }
    // Node's stat watcher handles atomic replacement, deletion and recreation without watching entire trees.
    watchFile(path, { persistent: false, interval: 500 }, changed)
    this.#stopWatching = () => unwatchFile(path, changed)
  }
}

function samePublication(a: PublishedArtifactReference, b: PublishedArtifactReference) {
  return (
    a.artifactId === b.artifactId &&
    a.version === b.version &&
    a.sha256 === b.sha256 &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.sourcePath === b.sourcePath
  )
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
