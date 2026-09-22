import {
  type ArtifactReference,
  attachmentArtifactReference,
  type FileArtifactReference,
} from "../artifacts/types.js"
import type { AgentEvent } from "../core/agent.js"
import { compactionSummaryMessage, isCompactionSummary } from "../core/compaction.js"
import {
  displayUserMessage,
  userMessageDocuments,
  userMessageImages,
  userMessageText,
} from "../inference/messages.js"
import type { ChatMessage, InferenceClient, UserChatMessage } from "../inference/types.js"
import type { SessionToolActivity, SessionTurnSegment } from "../storage/session-events.js"
import { describeToolCall, type ToolActivityKind } from "../tools/activity.js"
import { parseSerializedToolCall } from "../tools/schema.js"

type TranscriptKind = "message" | "reasoning" | "tool" | "debug"
type TranscriptSpeaker = "You" | "Otis" | "Thinking" | "Tool" | "Debug"
type TranscriptDelivery = "queued" | "steering"

/**
 * One mutation of the transcript. `upsert` covers both appended and patched entries; `reset`
 * means the entry list was replaced wholesale (session load, new session) and earlier changes no
 * longer apply.
 */
export type TranscriptChange =
  | { op: "reset" }
  | { op: "upsert"; id: number }
  | { op: "remove"; id: number }

export type TranscriptEntry = {
  id: number
  kind: TranscriptKind
  speaker: TranscriptSpeaker
  text: string
  activityKind?: ToolActivityKind
  toolCallId?: string
  reasoningId?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  diff?: string
  artifact?: FileArtifactReference
  /**
   * Artifact cards stay folded into tool activity until the turn chooses the last revision to
   * present.
   */
  artifactDisplay?: "pending" | "superseded" | "ready"
  artifacts?: ArtifactReference[]
  /**
   * User-authored text plus image labels, without document names that render as artifact cards in
   * graphical UIs.
   */
  messageText?: string
  streaming?: boolean
  delivery?: TranscriptDelivery
}

/**
 * Counts changed lines inside unified-diff hunks. Headers precede the first hunk, so content that
 * itself starts with "---" or "+++" (a Markdown rule, a front-matter fence) is counted like any
 * other line. A removal and addition with identical text differ only by the trailing newline,
 * which the "\ No newline" marker flags on either side; that pair is not a change.
 */
export function countDiffLines(diff: string) {
  let added = 0
  let removed = 0
  let inHunk = false
  let removal: string | undefined
  let addition: string | undefined
  const settle = () => {
    if (addition !== undefined) added += 1
    addition = undefined
  }
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      settle()
      inHunk = true
      removal = undefined
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("\\")) {
      if (addition !== undefined) {
        removed -= 1
        addition = undefined
      } else if (removal !== undefined) removal = `${removal}\u0000`
      continue
    }
    settle()
    if (line.startsWith("-")) {
      removed += 1
      removal = line.slice(1)
    } else if (line.startsWith("+")) {
      const text = line.slice(1)
      if (removal === `${text}\u0000`) removed -= 1
      else if (removal === text) addition = text
      else added += 1
      removal = undefined
    } else removal = undefined
  }
  settle()
  return { added, removed }
}

/**
 * Saved tool cards keyed by call id, in order, so repeated ids across compacted turns pair up with
 * their calls.
 */
export function groupToolActivities(activities: readonly SessionToolActivity[]) {
  const grouped = new Map<string, SessionToolActivity[]>()
  for (const activity of activities) {
    const matching = grouped.get(activity.toolCallId) ?? []
    matching.push(activity)
    grouped.set(activity.toolCallId, matching)
  }
  return grouped
}

export class TranscriptStore {
  readonly entries: TranscriptEntry[] = []
  readonly history: ChatMessage[] = []
  private nextMessageID = 1
  private nextLocalReasoningID = 1
  private observedContext?: { client: InferenceClient; tokens: number }
  private listeners = new Set<(change: TranscriptChange) => void>()
  private pendingArtifacts = new Map<string, number>()

  /** Notifies about every mutation. Returns an unsubscribe function. */
  subscribe(listener: (change: TranscriptChange) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(change: TranscriptChange) {
    for (const listener of this.listeners) listener(change)
  }

  contextTokens(client: InferenceClient | undefined) {
    return client && this.observedContext?.client === client
      ? this.observedContext.tokens
      : undefined
  }

  observeContext(client: InferenceClient, tokens: number) {
    this.observedContext = { client, tokens }
  }

  invalidateContext() {
    this.observedContext = undefined
  }

  /** Loads one finished run, including any steering messages within it. */
  loadMessages(messages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    this.history.push(...messages)
    this.loadEntries(messages, toolActivities)
  }

  replaceMessages(messages: ChatMessage[], turns: readonly SessionTurnSegment[] = [{ messages }]) {
    this.entries.length = 0
    this.history.length = 0
    this.nextMessageID = 1
    this.observedContext = undefined
    this.pendingArtifacts.clear()
    this.emit({ op: "reset" })
    this.history.push(...messages)
    for (const turn of turns) this.loadEntries(turn.messages, turn.toolActivities ?? [])
  }

  /** Replace model context while keeping the user's scrollback and pending entries intact. */
  loadCompacted(summary: string, keptMessages: ChatMessage[]) {
    this.history.length = 0
    this.observedContext = undefined
    this.history.push(compactionSummaryMessage(summary), ...keptMessages)
  }

  addUserMessage(message: string | UserChatMessage) {
    return this.addUserEntry(message)
  }

  addQueuedUserMessage(message: string | UserChatMessage) {
    return this.addUserEntry(message, "queued")
  }

  addSteeringUserMessage(message: string | UserChatMessage) {
    return this.addUserEntry(message, "steering")
  }

  activatePendingUserMessage(id: number) {
    const entry = this.entries.find((entry) => entry.id === id)
    if (!entry) return false
    this.entries.splice(this.entries.indexOf(entry), 1)
    const active = { ...entry }
    delete active.delivery
    this.entries.push(active)
    this.emit({ op: "remove", id })
    this.emit({ op: "upsert", id })
    return true
  }

  removeEntry(id: number) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    this.entries.splice(index, 1)
    for (const [key, entryId] of this.pendingArtifacts) {
      if (entryId === id) this.pendingArtifacts.delete(key)
    }
    this.emit({ op: "remove", id })
    return true
  }

  addAssistantMessage(text: string) {
    const entry = {
      id: this.nextMessageID++,
      kind: "message" as const,
      speaker: "Otis" as const,
      text,
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  addToolMessage(
    text: string,
    activityKind: ToolActivityKind,
    details: { toolCallId?: string; diff?: string; artifact?: FileArtifactReference } = {},
  ) {
    const entry = {
      id: this.nextMessageID++,
      kind: "tool" as const,
      speaker: "Tool" as const,
      text,
      activityKind,
      ...details,
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  addReasoningMessage(
    text: string,
    details: {
      reasoningId?: string
      startedAt?: string
      endedAt?: string
      durationMs?: number
      streaming?: boolean
    } = {},
  ) {
    const reasoningId = details.reasoningId ?? `local-reasoning-${this.nextLocalReasoningID++}`
    const entry = {
      id: this.nextMessageID++,
      kind: "reasoning" as const,
      speaker: "Thinking" as const,
      text,
      ...details,
      reasoningId,
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  addDebugMessage(text: string) {
    const entry = {
      id: this.nextMessageID++,
      kind: "debug" as const,
      speaker: "Debug" as const,
      text,
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  updateEntry(id: number, patch: Partial<Omit<TranscriptEntry, "id">>) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return
    this.entries[index] = { ...this.entries[index], ...patch }
    this.emit({ op: "upsert", id })
  }

  /**
   * Keeps every artifact reference on its tool entry for persistence, while marking only the
   * latest revision of a logical artifact as the card to reveal when the turn settles.
   */
  stageArtifact(entryId: number, artifact: FileArtifactReference) {
    const key =
      artifact.source === "published"
        ? `published:${artifact.artifactId}`
        : `workspace:${artifact.path.replaceAll("\\", "/")}`
    const previous = this.pendingArtifacts.get(key)
    if (previous !== undefined && previous !== entryId)
      this.updateEntry(previous, { artifactDisplay: "superseded" })
    this.pendingArtifacts.set(key, entryId)
    this.updateEntry(entryId, { artifact, artifactDisplay: "pending" })
  }

  /** Reveals the last revision of each artifact produced since the preceding turn boundary. */
  finalizeArtifacts() {
    if (this.pendingArtifacts.size === 0) return false
    for (const entryId of this.pendingArtifacts.values())
      this.updateEntry(entryId, { artifactDisplay: "ready" })
    this.pendingArtifacts.clear()
    return true
  }

  addMessages(messages: ChatMessage[]) {
    this.history.push(...messages)
  }

  /**
   * Collects the tool-card metadata for the given messages: the latest card per tool call, in
   * transcript order.
   */
  toolActivitiesFor(messages: readonly ChatMessage[]) {
    const remaining = new Map<string, number>()
    for (const message of messages) {
      if (message.role !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "tool_call")
          remaining.set(part.toolCall.id, (remaining.get(part.toolCall.id) ?? 0) + 1)
      }
    }
    const activities: SessionToolActivity[] = []
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      const { toolCallId, activityKind } = entry
      if (entry.kind !== "tool" || !toolCallId || !activityKind) continue
      const count = remaining.get(toolCallId) ?? 0
      if (count === 0) continue
      activities.push({
        toolCallId,
        activityKind,
        label: entry.text,
        ...(entry.diff !== undefined ? { diff: entry.diff } : {}),
        ...(entry.artifact !== undefined ? { artifact: entry.artifact } : {}),
      })
      remaining.set(toolCallId, count - 1)
    }
    return activities.reverse()
  }

  private loadEntries(messages: ChatMessage[], toolActivities: SessionToolActivity[]) {
    const activities = groupToolActivities(toolActivities)
    for (const message of messages) {
      if (message.role === "user" && !isCompactionSummary(message)) this.addUserMessage(message)
      if (message.role !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "text" && part.text) this.addAssistantMessage(part.text)
        if (part.type === "reasoning" && part.text) {
          const elapsed =
            part.startedAt && part.endedAt
              ? new Date(part.endedAt).getTime() - new Date(part.startedAt).getTime()
              : Number.NaN
          this.addReasoningMessage(part.text, {
            ...(part.id ? { reasoningId: part.id } : {}),
            ...(part.startedAt ? { startedAt: part.startedAt } : {}),
            ...(part.endedAt ? { endedAt: part.endedAt } : {}),
            ...(Number.isFinite(elapsed) ? { durationMs: Math.max(0, elapsed) } : {}),
          })
        }
        if (part.type !== "tool_call") continue
        let activity = activities.get(part.toolCall.id)?.shift()
        if (!activity) {
          // Older sessions saved no tool cards; rebuild the label from the call, skipping calls we
          // cannot parse.
          try {
            const described = describeToolCall(
              parseSerializedToolCall(part.toolCall.name, part.toolCall.arguments),
            )
            activity = {
              toolCallId: part.toolCall.id,
              activityKind: described.kind,
              label: described.label,
            }
          } catch {
            continue
          }
        }
        const entry = this.addToolMessage(activity.label, activity.activityKind, {
          toolCallId: activity.toolCallId,
          ...(activity.diff !== undefined ? { diff: activity.diff } : {}),
        })
        if (activity.artifact !== undefined) this.stageArtifact(entry.id, activity.artifact)
      }
    }
    this.finalizeArtifacts()
  }

  private addUserEntry(message: string | UserChatMessage, delivery?: TranscriptDelivery) {
    const text = typeof message === "string" ? message : displayUserMessage(message)
    const documents = typeof message === "string" ? [] : userMessageDocuments(message)
    const messageText =
      typeof message === "string" || documents.length === 0
        ? undefined
        : [
            userMessageText(message),
            ...userMessageImages(message).map((image) => `📎 ${image.name}`),
          ]
            .filter(Boolean)
            .join("\n")
    const entry = {
      id: this.nextMessageID++,
      kind: "message" as const,
      speaker: "You" as const,
      text,
      ...(messageText !== undefined ? { messageText } : {}),
      ...(documents.length > 0 ? { artifacts: documents.map(attachmentArtifactReference) } : {}),
      ...(delivery ? { delivery } : {}),
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }
}

/**
 * Projects one agent run's event stream onto a transcript as streamed assistant text, reasoning
 * cards, tool cards, and debug lines. The main conversation and every delegated run's trace use
 * the same projection.
 */
export class TranscriptProjector {
  #assistantText = ""
  #assistantEntry: TranscriptEntry | undefined
  readonly #reasoning = new Map<string, { entryId: number; text: string }>()
  readonly #tools = new Map<string, number>()

  constructor(private readonly transcript: TranscriptStore) {}

  /** Applies the event to the transcript and reports whether any entry changed. */
  apply(event: AgentEvent): boolean {
    const transcript = this.transcript
    if (event.type === "model") {
      const changed = this.#assistantEntry !== undefined
      this.#closeAssistantEntry()
      return changed
    }
    if (event.type === "delta") {
      this.#assistantText += event.text
      transcript.updateEntry(this.ensureAssistantEntry().id, {
        text: this.#assistantText,
        streaming: true,
      })
      return true
    }
    if (event.type === "debug") {
      for (const line of event.message.split("\n")) transcript.addDebugMessage(line)
      return true
    }
    if (event.type === "reasoning") {
      if (event.phase === "start") {
        this.#closeAssistantEntry()
        const entry = transcript.addReasoningMessage("", {
          reasoningId: event.reasoningId,
          startedAt: event.startedAt,
          streaming: true,
        })
        this.#reasoning.set(event.reasoningId, { entryId: entry.id, text: "" })
        return true
      }
      const reasoning = this.#reasoning.get(event.reasoningId)
      if (!reasoning) return false
      if (event.phase === "delta") {
        reasoning.text += event.text
        transcript.updateEntry(reasoning.entryId, { text: reasoning.text, streaming: true })
      } else {
        transcript.updateEntry(reasoning.entryId, {
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          streaming: false,
        })
      }
      return true
    }
    if (event.type !== "tool") return false
    if (event.phase === "start") {
      this.#closeAssistantEntry()
      const entry = transcript.addToolMessage(event.label, event.activityKind, {
        toolCallId: event.toolCallId,
      })
      this.#tools.set(event.toolCallId, entry.id)
      return true
    }
    if (!event.diff && !event.artifact) return false
    const entryId = this.#tools.get(event.toolCallId)
    if (entryId !== undefined) {
      if (event.diff) transcript.updateEntry(entryId, { diff: event.diff })
      if (event.artifact) transcript.stageArtifact(entryId, event.artifact)
    }
    return true
  }

  /**
   * The assistant message currently receiving text, created empty when the run has not produced
   * any yet.
   */
  ensureAssistantEntry(): TranscriptEntry {
    this.#assistantEntry ??= this.transcript.addAssistantMessage("")
    return this.#assistantEntry
  }

  /** Marks the streaming assistant message as finished once the run ends or is interrupted. */
  finishStreaming() {
    if (this.#assistantEntry)
      this.transcript.updateEntry(this.#assistantEntry.id, { streaming: false })
  }

  /** Finishes streamed text and reveals the last artifact revision produced by this turn. */
  finishTurn() {
    this.finishStreaming()
    return this.transcript.finalizeArtifacts()
  }

  /** Reasoning and tool activity end the current assistant message; later text starts anew. */
  #closeAssistantEntry() {
    this.finishStreaming()
    this.#assistantEntry = undefined
    this.#assistantText = ""
  }
}
