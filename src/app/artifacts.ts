import { createHash } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import { resolve } from "node:path"
import { isCanvasArtifact } from "../artifacts/canvas.js"
import {
  attachmentArtifactMetadata,
  loadAttachmentArtifact,
  loadWorkspaceArtifact,
  readWorkspaceArtifactBytes,
  workspaceArtifactMetadata,
} from "../artifacts/files.js"
import {
  ArtifactPublisher,
  loadPublishedArtifact,
  publishedArtifactMetadata,
  readPublishedArtifactBytes,
} from "../artifacts/publisher.js"
import {
  type ArtifactFile,
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
import type {
  AttachmentContentPart,
  ChatMessage,
  DocumentContentPart,
  ImageContentPart,
  UserChatMessage,
} from "../inference/types.js"
import type { JsonlSession, SessionToolActivity } from "../storage/index.js"
import { groupToolActivities } from "./transcript.js"

type ActiveArtifact =
  | { source: "workspace"; reference: WorkspaceArtifactReference }
  | { source: "attachment"; document: DocumentContentPart }
  | { source: "published"; artifactId: string; version?: number }

/** Session-scoped identities and selection. Adapters receive metadata, not document bytes. */
export class ArtifactStore {
  #active: ActiveArtifact | undefined
  #revision = 0
  #attachments = new Map<string, DocumentContentPart>()
  #images = new Map<string, ImageContentPart>()
  #published = new Map<string, PublishedArtifactReference[]>()
  #listeners = new Set<() => void>()
  #stopWatching: (() => void) | undefined
  #watchedPath: string | undefined

  constructor(
    private readonly cwd: string,
    private directory?: string,
  ) {}

  /** Original sources remain available to local tools after model-context compaction. */
  get attachments(): readonly AttachmentContentPart[] {
    return [...this.#attachments.values(), ...this.#images.values()]
  }

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

  /**
   * Watching is needed only while a UI subscribes. CLI/headless runs do not start background
   * watchers.
   */
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    this.#syncWatcher()
    return () => {
      this.#listeners.delete(listener)
      this.#syncWatcher()
    }
  }

  openWorkspace(reference: WorkspaceArtifactReference) {
    if (!isWorkspaceArtifactReference(reference))
      throw new Error("Invalid workspace artifact reference.")
    if (!isCanvasArtifact(reference.kind)) return
    this.#active = { source: "workspace", reference }
    this.#changed()
  }

  /**
   * Register trusted tool results. Background reads do not replace the document the user is
   * viewing.
   */
  observeFile(reference: FileArtifactReference) {
    if (!isFileArtifactReference(reference)) throw new Error("Invalid file artifact reference.")
    if (reference.source === "workspace") {
      const active = this.#active
      const viewing = active?.source === "workspace" && active.reference.path === reference.path
      if (isCanvasArtifact(reference.kind) && (!active || viewing)) this.openWorkspace(reference)
      return
    }
    const versions = this.#published.get(reference.artifactId) ?? []
    const existing = versions.find((item) => item.version === reference.version)
    if (existing && !samePublication(existing, reference))
      throw new Error("Conflicting artifact revision in session.")
    if (!existing)
      this.#published.set(
        reference.artifactId,
        [...versions, reference].sort((a, b) => a.version - b.version),
      )
    if (!isCanvasArtifact(reference.kind)) return
    // Preserve an explicitly selected older revision; otherwise the open artifact follows its
    // latest version.
    if (!this.#active || this.#active.source === "workspace") {
      this.#active = { source: "published", artifactId: reference.artifactId }
    }
    this.#changed()
  }

  openAttachment(document: DocumentContentPart) {
    this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    if (!isCanvasArtifact(attachmentArtifactReference(document).kind)) return
    this.#active = { source: "attachment", document }
    this.#changed()
  }

  observeMessage(message: UserChatMessage) {
    if (typeof message.content === "string") return
    for (const part of message.content) {
      if (part.type === "image")
        this.#images.set(
          `${part.name}:${createHash("sha256").update(part.data).digest("hex")}`,
          part,
        )
    }
    const documents = message.content.filter(
      (part): part is DocumentContentPart => part.type === "document",
    )
    for (const document of documents)
      this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    const document = documents
      .filter((item) => isCanvasArtifact(attachmentArtifactReference(item).kind))
      .at(-1)
    if (document) this.openAttachment(document)
  }

  clear() {
    this.#active = undefined
    this.#attachments.clear()
    this.#images.clear()
    this.#published.clear()
    this.directory = undefined
    this.#changed()
  }

  /** Full scrollback owns artifact history, independent of compaction of model context. */
  restore(
    messages: readonly ChatMessage[],
    activities: readonly SessionToolActivity[],
    directory = this.directory,
  ) {
    this.clear()
    this.directory = directory
    const byCall = groupToolActivities(activities)
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
    if (!isCanvasArtifact(reference.kind)) return false
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1 || reference.source !== "published")
    )
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

  async exportFile(revision: number): Promise<ArtifactFile | undefined> {
    const active = this.#active
    const metadata = this.metadata
    if (!active || !metadata || revision !== this.#revision) return undefined
    let bytes: Buffer
    if (active.source === "published") {
      const reference = this.#selectedPublished(active)
      if (!reference || !this.directory) return undefined
      bytes = await readPublishedArtifactBytes(reference, this.directory)
    } else if (active.source === "workspace") {
      bytes = await readWorkspaceArtifactBytes(this.cwd, active.reference)
    } else {
      bytes = Buffer.from(active.document.data, "base64")
    }
    return revision === this.#revision ? { name: metadata.title, bytes } : undefined
  }

  dispose() {
    this.#listeners.clear()
    this.clear()
  }

  #selectedPublished(active: Extract<ActiveArtifact, { source: "published" }>) {
    const versions = this.#published.get(active.artifactId)
    return active.version === undefined
      ? versions?.at(-1)
      : versions?.find((item) => item.version === active.version)
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
    // Node's stat watcher handles atomic replacement, deletion and recreation without watching
    // entire trees.
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

export function sessionArtifactPublisher(session: JsonlSession) {
  const references = session
    .replayTranscript()
    .toolActivities.map((activity) => activity.artifact)
    .filter((reference): reference is FileArtifactReference => reference !== undefined)
  return new ArtifactPublisher(session.artifactDirectory, references)
}
