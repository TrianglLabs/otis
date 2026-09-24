import { createHash } from "node:crypto"
import { readFileSync, unwatchFile, watchFile } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isCanvasArtifact } from "../artifacts/canvas.js"
import {
  attachmentArtifactMetadata,
  payloadFromBytes,
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
  isPublishedArtifactReference,
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
import type { JsonlSession } from "../storage/session.js"
import type { SessionToolActivity } from "../storage/session-events.js"
import { groupToolActivities } from "./transcript.js"

type ArtifactView =
  | { source: "workspace"; reference: WorkspaceArtifactReference }
  | { source: "attachment"; document: DocumentContentPart }
  | { source: "published"; artifactId: string; version?: number }

/** One Canvas tab: a view, its own revision, and when it last took the view. */
type OpenArtifact = {
  view: ArtifactView
  revision: number
  key?: string
  digest?: string
  activated: number
  stopWatching?: () => void
}

/** The user's pinned revision, kept beside the session's published copies so reloads honor it. */
const PIN_FILE = "pinned.json"

/** Activation stamps order tabs across every store in the process; ties never happen. */
let lastStamp = 0
function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

/**
 * Session-scoped identities and selection. Adapters receive metadata, not document bytes.
 *
 * What Canvas shows: every canvas artifact opened in the session is a tab, identified by its
 * metadata id, so a second document joins the first instead of replacing it. A newly produced
 * canvas artifact (published or written this turn) takes the view unless its own tab is pinned
 * to a version; attachments and background reads open only when nothing is open. Replay applies
 * the same rule in transcript order, then the persisted pin, and keeps only what was last in
 * view: earlier documents reopen from their cards.
 */
export class ArtifactStore {
  #open: OpenArtifact[] = []
  #active: OpenArtifact | undefined
  #attachments = new Map<string, DocumentContentPart>()
  #images = new Map<string, ImageContentPart>()
  #published = new Map<string, PublishedArtifactReference[]>()
  #listeners = new Set<() => void>()

  constructor(
    private readonly cwd: string,
    private directory?: string,
    /** How often an open working file is polled for external changes. */
    private readonly watchIntervalMs = 500,
  ) {}

  /** Original sources remain available to local tools after model-context compaction. */
  get attachments(): readonly AttachmentContentPart[] {
    return [...this.#attachments.values(), ...this.#images.values()]
  }

  /** The tab that last took the view. */
  get metadata(): ArtifactMetadata | undefined {
    return this.#active && this.#metadataOf(this.#active)
  }

  /** Every tab in opening order, each with the moment it last took the view. */
  get tabs(): { artifact: ArtifactMetadata; activated: number }[] {
    return this.#open.flatMap((tab) => {
      const artifact = this.#metadataOf(tab)
      return artifact ? [{ artifact, activated: tab.activated }] : []
    })
  }

  setDirectory(directory: string) {
    if (this.directory === directory) return
    this.directory = directory
    this.#published.clear()
    for (const tab of this.#open.filter((tab) => tab.view.source === "published")) this.#drop(tab)
    this.#notify()
  }

  /**
   * Watching is needed only while a UI subscribes. CLI/headless runs do not start background
   * watchers.
   */
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    this.#syncWatchers()
    return () => {
      this.#listeners.delete(listener)
      this.#syncWatchers()
    }
  }

  openWorkspace(reference: WorkspaceArtifactReference) {
    if (!isWorkspaceArtifactReference(reference))
      throw new Error("Invalid workspace artifact reference.")
    if (!isCanvasArtifact(reference.kind)) return
    this.#take({ source: "workspace", reference })
  }

  /**
   * Register a trusted tool result. A produced file (written or published) takes the view unless
   * its tab is pinned to a version; a background read (`produced` false) opens only when nothing
   * is open.
   */
  observeFile(reference: FileArtifactReference, produced = true) {
    if (!isFileArtifactReference(reference)) throw new Error("Invalid file artifact reference.")
    if (reference.source === "published") {
      produced = true
      const versions = this.#published.get(reference.artifactId) ?? []
      const existing = versions.find((item) => item.version === reference.version)
      if (existing && !samePublication(existing, reference))
        throw new Error("Conflicting artifact revision in session.")
      if (!existing)
        this.#published.set(
          reference.artifactId,
          [...versions, reference].sort((a, b) => a.version - b.version),
        )
    }
    const view: ArtifactView =
      reference.source === "workspace"
        ? { source: "workspace", reference }
        : { source: "published", artifactId: reference.artifactId }
    const tab = this.#tab(viewId(view))
    const pinned = tab?.view.source === "published" && tab.view.version !== undefined
    if (isCanvasArtifact(reference.kind) && !pinned && (produced || this.#open.length === 0))
      this.#take(view)
    else if (tab && reference.source === "published") this.#changed(tab) // its version list grew
  }

  openAttachment(document: DocumentContentPart) {
    this.#attachments.set(attachmentKey(attachmentArtifactReference(document)), document)
    if (!isCanvasArtifact(attachmentArtifactReference(document).kind)) return
    this.#take({ source: "attachment", document })
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
    if (document && this.#open.length === 0) this.openAttachment(document)
  }

  clear() {
    for (const tab of this.#open) tab.stopWatching?.()
    this.#open = []
    this.#active = undefined
    this.#attachments.clear()
    this.#images.clear()
    this.#published.clear()
    this.directory = undefined
    this.#notify()
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
        this.observeFile(activity.artifact, activity.activityKind !== "file_read")
      }
    }
    const pin = this.#readPin()
    if (pin) this.open(pin.reference, pin.version)
    for (const tab of this.#open.filter((tab) => tab !== this.#active)) this.#drop(tab)
    this.#notify()
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
      this.#take({ source: "published", artifactId: reference.artifactId, version })
      this.#writePin(version === undefined ? undefined : { reference, version })
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

  /** Closes a tab; the one opened last is left in view. A pinned version closed is unpinned. */
  close(id: string) {
    const tab = this.#tab(id)
    if (!tab) return
    if (tab.view.source === "published" && tab.view.version !== undefined) this.#writePin(undefined)
    this.#drop(tab)
    this.#notify()
  }

  /** The payload for a tab's revision, or undefined once that revision is stale. */
  async load(id: string, revision: number): Promise<ArtifactPayload | undefined> {
    const tab = this.#tab(id)
    if (!tab || revision !== tab.revision) return undefined
    const { view } = tab
    let payload: ArtifactPayload
    if (view.source === "published") {
      const reference = this.#selectedPublished(view)
      if (!reference || !this.directory) return undefined
      payload = await loadPublishedArtifact(reference, revision, this.directory)
    } else if (view.source === "workspace") {
      const bytes = await readWorkspaceArtifactBytes(this.cwd, view.reference)
      if (this.#open.includes(tab)) tab.digest = digest(bytes)
      payload = await payloadFromBytes(
        bytes,
        workspaceArtifactMetadata(view.reference, revision),
        view.reference.path,
      )
    } else {
      payload = await payloadFromBytes(
        Buffer.from(view.document.data, "base64"),
        attachmentArtifactMetadata(view.document, revision),
        view.document.name,
      )
    }
    return this.#open.includes(tab) && revision === tab.revision ? payload : undefined
  }

  async exportFile(id: string, revision: number): Promise<ArtifactFile | undefined> {
    const tab = this.#tab(id)
    const metadata = tab && this.#metadataOf(tab)
    if (!tab || !metadata || revision !== tab.revision) return undefined
    const { view } = tab
    let bytes: Buffer
    if (view.source === "published") {
      const reference = this.#selectedPublished(view)
      if (!reference || !this.directory) return undefined
      bytes = await readPublishedArtifactBytes(reference, this.directory)
    } else if (view.source === "workspace") {
      bytes = await readWorkspaceArtifactBytes(this.cwd, view.reference)
    } else {
      bytes = Buffer.from(view.document.data, "base64")
    }
    return this.#open.includes(tab) && revision === tab.revision
      ? { name: metadata.title, bytes }
      : undefined
  }

  dispose() {
    this.#listeners.clear()
    this.clear()
  }

  #tab(id: string) {
    return this.#open.find((tab) => viewId(tab.view) === id)
  }

  #metadataOf(tab: OpenArtifact): ArtifactMetadata | undefined {
    const { view, revision } = tab
    if (view.source === "published") {
      const reference = this.#selectedPublished(view)
      if (!reference) return undefined
      return {
        ...publishedArtifactMetadata(reference, revision),
        publication: {
          reference,
          versions: (this.#published.get(view.artifactId) ?? []).map((item) => item.version),
          followingLatest: view.version === undefined,
        },
      }
    }
    return view.source === "workspace"
      ? workspaceArtifactMetadata(view.reference, revision)
      : attachmentArtifactMetadata(view.document, revision)
  }

  /** A view takes the Canvas: its tab (new, or the one with its id) is activated. */
  #take(view: ArtifactView) {
    let tab = this.#tab(viewId(view))
    if (!tab) {
      tab = { view, revision: 0, activated: 0 }
      this.#open.push(tab)
    }
    tab.view = view
    tab.activated = stamp()
    this.#active = tab
    this.#changed(tab)
  }

  #drop(tab: OpenArtifact) {
    tab.stopWatching?.()
    this.#open.splice(this.#open.indexOf(tab), 1)
    if (this.#active === tab) this.#active = this.#open.at(-1)
  }

  #selectedPublished(view: Extract<ArtifactView, { source: "published" }>) {
    const versions = this.#published.get(view.artifactId)
    return view.version === undefined
      ? versions?.at(-1)
      : versions?.find((item) => item.version === view.version)
  }

  /**
   * A tab's revision advances only when its selected reference or content changes, so listeners
   * can refresh metadata such as the version list without refetching an unchanged preview.
   */
  #changed(tab: OpenArtifact, contentChanged = false) {
    const metadata = this.#metadataOf(tab)
    const key =
      metadata && JSON.stringify([metadata.id, metadata.path, metadata.publication?.reference])
    if (contentChanged || key !== tab.key) tab.revision += 1
    tab.key = key
    this.#notify()
  }

  #notify() {
    this.#syncWatchers()
    for (const listener of this.#listeners) listener()
  }

  /** Every open working file is watched while a UI subscribes; nothing is watched otherwise. */
  #syncWatchers() {
    for (const tab of this.#open) {
      if (this.#listeners.size === 0) {
        tab.stopWatching?.()
        tab.stopWatching = undefined
      } else if (tab.view.source === "workspace" && !tab.stopWatching) this.#watch(tab)
    }
  }

  #watch(tab: OpenArtifact) {
    if (tab.view.source !== "workspace") return
    const { reference } = tab.view
    const path = resolve(this.cwd, reference.path)
    // A stat change with identical bytes (touch, chmod, a rewrite of the same text) is not a new
    // revision; a missing or unreadable file always is.
    const changed = async () => {
      const next = await readWorkspaceArtifactBytes(this.cwd, reference).then(
        digest,
        () => undefined,
      )
      if (!tab.stopWatching || next === tab.digest) return
      tab.digest = next
      this.#changed(tab, true)
    }
    const tick = () => void changed()
    // Node's stat watcher handles atomic replacement, deletion and recreation without watching
    // entire trees.
    watchFile(path, { persistent: false, interval: this.watchIntervalMs }, tick)
    tab.stopWatching = () => unwatchFile(path, tick)
  }

  #readPin() {
    if (!this.directory) return undefined
    try {
      const pin: unknown = JSON.parse(readFileSync(join(this.directory, PIN_FILE), "utf8"))
      if (
        typeof pin !== "object" ||
        pin === null ||
        !isPublishedArtifactReference((pin as { reference?: unknown }).reference) ||
        typeof (pin as { version?: unknown }).version !== "number"
      )
        return undefined
      return pin as { reference: PublishedArtifactReference; version: number }
    } catch {
      return undefined
    }
  }

  #writePin(pin: { reference: PublishedArtifactReference; version: number } | undefined) {
    if (!this.directory) return
    const path = join(this.directory, PIN_FILE)
    void (
      pin ? writeFile(path, JSON.stringify(pin), { mode: 0o600 }) : rm(path, { force: true })
    ).catch(() => {})
  }
}

/** A tab's identity is its metadata id, so the same document always lands in the same tab. */
function viewId(view: ArtifactView) {
  if (view.source === "workspace") return `workspace:${view.reference.path}`
  if (view.source === "published") return `published:${view.artifactId}`
  return `attachment:${view.document.sha256}`
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
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
