import { stat } from "node:fs/promises"
import {
  isPublishedArtifactReference,
  type PublishedArtifactReference,
} from "../artifacts/types.js"
import { isCompactionSummary } from "../core/compaction.js"
import { summarizeUserMessage, userMessageText } from "../inference/messages.js"
import type { ChatMessage, TokenUsage, UserChatMessage } from "../inference/types.js"
import {
  readSessionEvents,
  replaySessionMessages,
  replaySessionTranscript,
  type SessionEvent,
  type SessionView,
} from "./session-events.js"

/**
 * How a session's last turn ended: `interrupted` when the model was stopped mid-answer, `pending`
 * when a prompt was admitted and never answered, `complete` otherwise (including no prompts).
 */
export type SessionState = "complete" | "interrupted" | "pending"

export type SessionSummary = {
  id: string
  title: string
  messageCount: number
  updatedAt: string
  mtimeMs: number
  state: SessionState
  /** Present when the session was last on screen with others. */
  view?: SessionView
}

/** The events usage stats derive from, without their payloads. */
export type SessionActivity =
  | {
      type:
        | "prompt_admitted"
        | "prompt_steered"
        | "turn_started"
        | "turn_completed"
        | "turn_interrupted"
      at: string
      promptId: string
    }
  | { type: "usage_recorded"; at: string; usage: TokenUsage }

/**
 * What listings, search, the home screen and usage stats each need from a session on disk. One
 * parse per file version serves them all; a session file only ever grows, so its size and mtime
 * identify a version.
 */
export type SessionDigest = {
  summary: Omit<SessionSummary, "id">
  /** Each user and assistant message on one line, compaction summaries excluded. */
  texts: string[]
  /** Documents the session published, each stamped by the turn that ended on disk. */
  artifacts: { reference: PublishedArtifactReference; endedAt?: string }[]
  activity: SessionActivity[]
}

/**
 * Fallback titles derive from the first user message, which can be a pasted paragraph — cap them
 * so pickers and headers stay neat. Mirrors GENERATED_TITLE_MAX_LENGTH in src/app/sessions.ts
 * (storage can't import app).
 */
const FALLBACK_TITLE_MAX_LENGTH = 60

const digests = new Map<string, { size: number; digest: SessionDigest }>()

export async function readSessionDigest(filePath: string): Promise<SessionDigest> {
  const { mtimeMs, size } = await stat(filePath)
  const known = digests.get(filePath)
  if (known && known.size === size && known.digest.summary.mtimeMs === mtimeMs) return known.digest
  const digest = digestEvents(await readSessionEvents(filePath), mtimeMs)
  digests.set(filePath, { size, digest })
  return digest
}

export function forgetSessionDigest(filePath: string) {
  digests.delete(filePath)
}

function digestEvents(events: readonly SessionEvent[], mtimeMs: number): SessionDigest {
  const view = sessionView(events)
  const messages = replaySessionMessages(events)
  const transcript = replaySessionTranscript(events)
  // Activities archived at a compaction checkpoint end with their prompt's turn event.
  const endedAt = new Map<string, string>()
  const archived = new Map<string, string[]>()
  const activity: SessionActivity[] = []
  for (const event of events) {
    if (event.type === "compacted" && event.promptId && event.turn?.toolActivities) {
      const ids = event.turn.toolActivities.map((activity) => activity.toolCallId)
      archived.set(event.promptId, [...(archived.get(event.promptId) ?? []), ...ids])
    } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      const ids = (event.toolActivities ?? []).map((activity) => activity.toolCallId)
      for (const id of [...(archived.get(event.promptId) ?? []), ...ids]) endedAt.set(id, event.at)
    }
    if (event.type === "usage_recorded")
      activity.push({ type: event.type, at: event.at, usage: event.usage })
    else if (
      event.type === "prompt_admitted" ||
      event.type === "prompt_steered" ||
      event.type === "turn_started" ||
      event.type === "turn_completed" ||
      event.type === "turn_interrupted"
    )
      activity.push({ type: event.type, at: event.at, promptId: event.promptId })
  }
  return {
    summary: {
      title: sessionTitle(events),
      messageCount: messages.length,
      updatedAt: events.at(-1)?.at ?? new Date(0).toISOString(),
      mtimeMs,
      state: sessionState(events),
      ...(view && view.members.length > 1 ? { view } : {}),
    },
    // The full transcript, not the model-context replay: compaction drops pre-compaction messages
    // from the model's view, but the user's original text is still on disk and stays searchable.
    texts: transcript.messages.flatMap((message) =>
      message.role === "tool" || isCompactionSummary(message) ? [] : [messageText(message)],
    ),
    artifacts: transcript.toolActivities.flatMap(({ toolCallId, artifact }) =>
      isPublishedArtifactReference(artifact)
        ? [{ reference: artifact, endedAt: endedAt.get(toolCallId) }]
        : [],
    ),
    activity,
  }
}

function messageText(message: Exclude<ChatMessage, { role: "tool" }>) {
  const text =
    message.role === "user"
      ? userMessageText(message)
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
  return text.replace(/\s+/g, " ").trim()
}

/** Falls back to the first prompt in model history, or in scrollback when none was answered. */
export function sessionTitle(events: readonly SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === "title_renamed") return event.title
  }
  const firstPrompt = (messages: readonly ChatMessage[]) =>
    messages.find(
      (message): message is UserChatMessage =>
        message.role === "user" && !isCompactionSummary(message),
    )
  const firstUser =
    firstPrompt(replaySessionMessages(events)) ??
    firstPrompt(replaySessionTranscript(events).messages)
  if (!firstUser) return "Current session"
  const text = (userMessageText(firstUser) || summarizeUserMessage(firstUser))
    .trim()
    .split("\n")[0]
    .trim()
  if (!text) return "Current session"
  if (text.length <= FALLBACK_TITLE_MAX_LENGTH) return text
  const cut = text.slice(0, FALLBACK_TITLE_MAX_LENGTH)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** The last arrangement on file. */
export function sessionView(events: readonly SessionEvent[]): SessionView | undefined {
  const event = events.findLast((event) => event.type === "view_arranged")
  return event && { members: event.members, axis: event.axis }
}

/** An admitted prompt without an ending event is pending; otherwise the last ending event decides. */
function sessionState(events: readonly SessionEvent[]): SessionState {
  const open = new Set<string>()
  let interrupted = false
  for (const event of events) {
    if (event.type === "prompt_admitted") open.add(event.promptId)
    else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      open.delete(event.promptId)
      interrupted = event.type === "turn_interrupted"
    }
  }
  return open.size > 0 ? "pending" : interrupted ? "interrupted" : "complete"
}
