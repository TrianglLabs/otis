import { compactionSummaryMessage, isCompactionSummary } from "../core/compaction.js"
import { displayUserMessage } from "../inference/messages.js"
import type { ChatMessage, ChatToolCall, InferenceClient, ReasoningContentPart } from "../inference/types.js"
import type { SessionToolActivity } from "../storage/index.js"
import { describeToolCall, type ToolActivityKind } from "../tools/activity.js"
import { parseSerializedToolCall } from "../tools/schema.js"

export type TranscriptKind = "message" | "reasoning" | "tool" | "debug"
export type TranscriptSpeaker = "You" | "Otis" | "Thinking" | "Tool" | "Debug"
export type TranscriptDelivery = "queued" | "steering"

/**
 * One mutation of the transcript. `upsert` covers both appended and patched entries; `reset` means the entry list
 * was replaced wholesale (session load, new session) and earlier changes no longer apply.
 */
export type TranscriptChange = { op: "reset" } | { op: "upsert"; id: number } | { op: "remove"; id: number }

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
  streaming?: boolean
  delivery?: TranscriptDelivery
}

export class TranscriptStore {
  readonly entries: TranscriptEntry[] = []
  readonly history: ChatMessage[] = []
  private nextMessageID = 1
  private nextLocalReasoningID = 1
  private observedContext?: { client: InferenceClient; tokens: number }
  private listeners = new Set<(change: TranscriptChange) => void>()

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
    return client && this.observedContext?.client === client ? this.observedContext.tokens : undefined
  }

  observeContext(client: InferenceClient, tokens: number) {
    this.observedContext = { client, tokens }
  }

  loadMessages(messages: ChatMessage[], toolActivities: SessionToolActivity[] = [], displayMessages = messages) {
    this.history.push(...messages)
    this.loadEntries(displayMessages, toolActivities)
  }

  replaceMessages(messages: ChatMessage[], toolActivities: SessionToolActivity[] = [], displayMessages = messages) {
    this.entries.length = 0
    this.history.length = 0
    this.nextMessageID = 1
    this.observedContext = undefined
    this.emit({ op: "reset" })
    this.loadMessages(messages, toolActivities, displayMessages)
  }

  /**
   * Replace model context while keeping the user's scrollback and pending entries intact.
   */
  loadCompacted(summary: string, keptMessages: ChatMessage[]) {
    this.history.length = 0
    this.observedContext = undefined

    this.history.push(compactionSummaryMessage(summary), ...keptMessages)
  }

  addUserMessage(message: string | Extract<ChatMessage, { role: "user" }>) {
    return this.addUserEntry(message)
  }

  addQueuedUserMessage(message: string | Extract<ChatMessage, { role: "user" }>) {
    return this.addUserEntry(message, "queued")
  }

  addSteeringUserMessage(message: string | Extract<ChatMessage, { role: "user" }>) {
    return this.addUserEntry(message, "steering")
  }

  activatePendingUserMessage(id: number) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    const [entry] = this.entries.splice(index, 1)
    if (!entry) return false
    const active = { ...entry }
    delete active.delivery
    this.entries.push(active)
    this.emit({ op: "remove", id: entry.id })
    this.emit({ op: "upsert", id: active.id })
    return true
  }

  removeEntry(id: number) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    this.entries.splice(index, 1)
    this.emit({ op: "remove", id })
    return true
  }

  addAssistantMessage(text: string) {
    const entry = { id: this.nextMessageID++, kind: "message" as const, speaker: "Otis" as const, text }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  addToolMessage(text: string, activityKind: ToolActivityKind, details: { toolCallId?: string; diff?: string } = {}) {
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
    const entry = { id: this.nextMessageID++, kind: "debug" as const, speaker: "Debug" as const, text }
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

  addMessages(messages: ChatMessage[]) {
    this.history.push(...messages)
  }

  /** Collects the tool-card metadata for the given messages: the latest card per tool call, in transcript order. */
  toolActivitiesFor(messages: readonly ChatMessage[]) {
    const remainingCalls = toolCallCounts(messages)
    const activities: SessionToolActivity[] = []

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (!isToolCard(entry)) continue
      const remaining = remainingCalls.get(entry.toolCallId) ?? 0
      if (remaining === 0) continue
      activities.push(toolActivity(entry))
      remainingCalls.set(entry.toolCallId, remaining - 1)
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
        if (part.type === "reasoning" && part.text) this.addReasoningPart(part)
        if (part.type === "tool_call") {
          const activity = takeToolActivity(activities, part.toolCall.id) ?? activityFromToolCall(part.toolCall)
          if (!activity) continue
          this.addToolMessage(activity.label, activity.activityKind, {
            toolCallId: activity.toolCallId,
            ...(activity.diff !== undefined ? { diff: activity.diff } : {}),
          })
        }
      }
    }
  }

  private addUserEntry(message: string | Extract<ChatMessage, { role: "user" }>, delivery?: TranscriptDelivery) {
    const text = typeof message === "string" ? message : displayUserMessage(message)
    const entry = {
      id: this.nextMessageID++,
      kind: "message" as const,
      speaker: "You" as const,
      text,
      ...(delivery ? { delivery } : {}),
    }
    this.entries.push(entry)
    this.emit({ op: "upsert", id: entry.id })
    return entry
  }

  private addReasoningPart(part: ReasoningContentPart) {
    const durationMs = reasoningDuration(part)
    this.addReasoningMessage(part.text, {
      ...(part.id ? { reasoningId: part.id } : {}),
      ...(part.startedAt ? { startedAt: part.startedAt } : {}),
      ...(part.endedAt ? { endedAt: part.endedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
  }
}

function reasoningDuration(part: ReasoningContentPart) {
  if (!part.startedAt || !part.endedAt) return undefined
  const durationMs = new Date(part.endedAt).getTime() - new Date(part.startedAt).getTime()
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined
}

function groupToolActivities(activities: SessionToolActivity[]) {
  const grouped = new Map<string, SessionToolActivity[]>()
  for (const activity of activities) {
    const matching = grouped.get(activity.toolCallId) ?? []
    matching.push(activity)
    grouped.set(activity.toolCallId, matching)
  }
  return grouped
}

function takeToolActivity(grouped: Map<string, SessionToolActivity[]>, toolCallId: string) {
  return grouped.get(toolCallId)?.shift()
}

type ToolCardEntry = TranscriptEntry & { kind: "tool"; toolCallId: string; activityKind: ToolActivityKind }

function isToolCard(entry: TranscriptEntry | undefined): entry is ToolCardEntry {
  return entry?.kind === "tool" && Boolean(entry.toolCallId) && Boolean(entry.activityKind)
}

function toolActivity(entry: ToolCardEntry): SessionToolActivity {
  return {
    toolCallId: entry.toolCallId,
    activityKind: entry.activityKind,
    label: entry.text,
    ...(entry.diff !== undefined ? { diff: entry.diff } : {}),
  }
}

function activityFromToolCall(toolCall: ChatToolCall): SessionToolActivity | undefined {
  try {
    const activity = describeToolCall(parseSerializedToolCall(toolCall.name, toolCall.arguments))
    return { toolCallId: toolCall.id, activityKind: activity.kind, label: activity.label }
  } catch {
    return undefined
  }
}

function toolCallCounts(messages: readonly ChatMessage[]) {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool_call") continue
      counts.set(part.toolCall.id, (counts.get(part.toolCall.id) ?? 0) + 1)
    }
  }
  return counts
}
