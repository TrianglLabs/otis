import { compactionSummaryMessage, extractCompactionSummary, isCompactionSummary } from "../core/compaction.js"
import type { ChatMessage, ChatToolCall } from "../inference/types.js"
import type { SessionToolActivity } from "../storage/index.js"
import { describeToolCall, type ToolActivityKind } from "../tools/activity.js"
import { parseSerializedToolCall } from "../tools/schema.js"

export type TranscriptKind = "message" | "tool" | "debug"
export type TranscriptSpeaker = "You" | "Otis" | "Tool" | "Debug"

export type TranscriptEntry = {
  id: number
  kind: TranscriptKind
  speaker: TranscriptSpeaker
  text: string
  activityKind?: ToolActivityKind
  toolCallId?: string
  diff?: string
  streaming?: boolean
}

export class TranscriptStore {
  readonly entries: TranscriptEntry[] = []
  readonly history: ChatMessage[] = []
  private nextMessageID = 1

  loadMessages(messages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    this.history.push(...messages)
    this.loadEntries(messages, toolActivities)
  }

  replaceMessages(messages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    this.entries.length = 0
    this.history.length = 0
    this.nextMessageID = 1
    this.loadMessages(messages, toolActivities)
  }

  /**
   * Replace the entire transcript with a compaction summary + kept messages.
   * The summary is stored as a user message in history (for the LLM) but
   * displayed as an Otis message in the transcript.
   */
  loadCompacted(summary: string, keptMessages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    this.entries.length = 0
    this.history.length = 0
    this.nextMessageID = 1

    this.history.push(compactionSummaryMessage(summary), ...keptMessages)
    this.addAssistantMessage(
      `**Conversation compacted.** Older messages were summarized to free context.\n\n${summary}`,
    )

    this.loadEntries(keptMessages, toolActivities)
  }

  addUserMessage(text: string) {
    const entry = { id: this.nextMessageID++, kind: "message" as const, speaker: "You" as const, text }
    this.entries.push(entry)
    return entry
  }

  addAssistantMessage(text: string) {
    const entry = { id: this.nextMessageID++, kind: "message" as const, speaker: "Otis" as const, text }
    this.entries.push(entry)
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
    return entry
  }

  addDebugMessage(text: string) {
    const entry = { id: this.nextMessageID++, kind: "debug" as const, speaker: "Debug" as const, text }
    this.entries.push(entry)
    return entry
  }

  updateEntry(id: number, patch: Partial<Omit<TranscriptEntry, "id">>) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return

    this.entries[index] = { ...this.entries[index], ...patch }
  }

  addMessages(messages: ChatMessage[]) {
    this.history.push(...messages)
  }

  toolActivitiesFor(messages: ChatMessage[]) {
    const remainingCalls = toolCallCounts(messages)
    const activities: SessionToolActivity[] = []

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (entry.kind !== "tool" || !entry.toolCallId || !entry.activityKind) continue
      const remaining = remainingCalls.get(entry.toolCallId) ?? 0
      if (remaining === 0) continue

      activities.push({
        toolCallId: entry.toolCallId,
        activityKind: entry.activityKind,
        label: entry.text,
        ...(entry.diff !== undefined ? { diff: entry.diff } : {}),
      })
      remainingCalls.set(entry.toolCallId, remaining - 1)
    }

    return activities.reverse()
  }

  private loadEntries(messages: ChatMessage[], toolActivities: SessionToolActivity[]) {
    const activities = groupToolActivities(toolActivities)

    for (const message of messages) {
      if (message.role === "user") {
        if (isCompactionSummary(message)) {
          this.addAssistantMessage(
            `**Conversation compacted.** Older messages were summarized to free context.\n\n${extractCompactionSummary(message)}`,
          )
        } else {
          this.addUserMessage(message.content)
        }
      }

      if (message.role !== "assistant") continue

      const text = assistantText(message)
      if (text) this.addAssistantMessage(text)

      for (const part of message.content) {
        if (part.type !== "tool_call") continue
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

function assistantText(message: Extract<ChatMessage, { role: "assistant" }>) {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
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

function activityFromToolCall(toolCall: ChatToolCall): SessionToolActivity | undefined {
  try {
    const activity = describeToolCall(parseSerializedToolCall(toolCall.name, toolCall.arguments))
    return { toolCallId: toolCall.id, activityKind: activity.kind, label: activity.label }
  } catch {
    return undefined
  }
}

function toolCallCounts(messages: ChatMessage[]) {
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
