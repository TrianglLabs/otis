import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { type FileArtifactReference, isFileArtifactReference } from "../artifacts/types.js"
import { compactionSummaryMessage } from "../core/compaction.js"
import {
  DOCX_MIME_TYPE,
  isSupportedDocumentMimeType,
  MAX_DOCUMENTS_PER_MESSAGE,
  MAX_EXTRACTED_DOCUMENT_CHARS,
  MAX_RAW_DOCUMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS,
  PDF_MIME_TYPE,
} from "../inference/document-constraints.js"
import {
  type ChatMessage,
  type DocumentContentPart,
  type ImageContentPart,
  MAX_BASE64_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  type TokenUsage,
  type UserChatMessage,
  type UserContentPart,
} from "../inference/types.js"
import { isToolActivityKind, type ToolActivityKind } from "../tools/activity.js"

export type BaseSessionEvent = {
  seq: number
  sessionId: string
  at: string
}

export type SessionToolActivity = {
  toolCallId: string
  activityKind: ToolActivityKind
  label: string
  diff?: string
  artifact?: FileArtifactReference
}

export type SessionSubagentStatus = "complete" | "failed" | "interrupted"

/** The full trace of one delegated run, keyed by the parent's `agent` call in the same turn. */
export type SessionSubagentRun = {
  toolCallId: string
  title: string
  status: SessionSubagentStatus
  messages: ChatMessage[]
  toolActivities?: SessionToolActivity[]
  durationMs?: number
}

/** Tool cards and delegated traces that accompany a turn's messages. */
export type SessionTurnDetails = {
  toolActivities?: SessionToolActivity[]
  subagents?: SessionSubagentRun[]
}

/** The part of an active turn archived before its model context is compacted. */
export type SessionTurnSegment = SessionTurnDetails & { messages: ChatMessage[] }

export type SessionReplay = {
  messages: ChatMessage[]
  toolActivities: SessionToolActivity[]
  subagents: SessionSubagentRun[]
}

/** Human scrollback retains admitted turn boundaries even through steering and compaction. */
export type SessionTranscriptReplay = SessionReplay & { turns: SessionTurnSegment[] }

export type UsagePurpose = "agent" | "compaction" | "title"

export type NewSessionEvent =
  | { type: "session_started"; version: 1; cwd?: string }
  | { type: "prompt_admitted"; promptId: string; message: UserChatMessage }
  | { type: "turn_started"; promptId: string }
  | { type: "prompt_steered"; promptId: string; message: UserChatMessage }
  | ({ type: "turn_completed"; promptId: string; messages: ChatMessage[] } & SessionTurnDetails)
  | ({ type: "turn_interrupted"; promptId: string; messages: ChatMessage[] } & SessionTurnDetails)
  | ({
      type: "compacted"
      summary: string
      messages: ChatMessage[]
      throughSeq?: number
      promptId?: string
      steeringCount?: number
      turn?: SessionTurnSegment
    } & SessionTurnDetails)
  | { type: "usage_recorded"; purpose: UsagePurpose; promptId?: string; usage: TokenUsage }
  | { type: "title_renamed"; title: string }

export type SessionEvent = BaseSessionEvent & NewSessionEvent

const IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/x-portable-pixmap",
]

export async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  let content: string
  try {
    content = await readFile(filePath, "utf8")
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const events: SessionEvent[] = []
  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = rawLine.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid session JSON at line ${index + 1}: ${(error as Error).message}`)
    }
    const event = parseSessionEvent(value, index + 1)
    const previous = events.at(-1)
    const expectedSeq = (previous?.seq ?? 0) + 1
    if (event.seq !== expectedSeq) {
      throw new Error(`Invalid session sequence at line ${index + 1}: expected ${expectedSeq}`)
    }
    if (previous && event.sessionId !== previous.sessionId) {
      throw new Error(`Invalid session event at line ${index + 1}: sessionId changed`)
    }
    events.push(event)
  }
  return events
}

type ReplayTurn = {
  promptId?: string
  admittedSeq?: number
  continuation?: boolean
  /** All steering admitted for this turn, so a checkpoint can preserve the unconsumed suffix. */
  steered?: UserChatMessage[]
  messages: ChatMessage[]
  toolActivities: SessionToolActivity[]
  subagents: SessionSubagentRun[]
}

export function replaySession(events: readonly SessionEvent[]): SessionReplay {
  let base: ReplayTurn = { messages: [], toolActivities: [], subagents: [] }
  const turns: ReplayTurn[] = []

  for (const event of events) {
    if (event.type === "compacted") {
      const active = event.promptId ? findReplayTurn(turns, event.promptId) : undefined
      base = replayTurn([compactionSummaryMessage(event.summary), ...event.messages], event)
      const throughSeq = event.throughSeq
      const preserved =
        throughSeq === undefined
          ? []
          : turns.filter((turn) => turn.admittedSeq !== undefined && turn.admittedSeq > throughSeq)
      turns.length = 0
      if (event.promptId) {
        const steered = active?.steered ?? []
        turns.push({
          ...replayTurn(steered.slice(event.steeringCount)),
          promptId: event.promptId,
          admittedSeq: throughSeq,
          continuation: true,
          steered,
        })
      }
      turns.push(...preserved)
    } else if (event.type === "prompt_admitted") {
      turns.push({
        ...replayTurn([event.message]),
        promptId: event.promptId,
        admittedSeq: event.seq,
      })
    } else if (event.type === "prompt_steered") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) {
        turn.messages.push(event.message)
        turn.steered ??= []
        turn.steered.push(event.message)
      } else turns.push(replayTurn([event.message]))
    } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) {
        Object.assign(
          turn,
          replayTurn(
            turn.continuation ? event.messages : [turn.messages[0], ...event.messages],
            event,
          ),
        )
      } else {
        turns.push(replayTurn([...event.messages], event))
      }
    }
  }

  // A prompt that never received a response is scrollback, not model history: it would be an
  // unanswered message every later request and compaction has to carry. This also covers older
  // files whose admitted prompt has no ending event.
  const all = [base, ...turns.filter((turn) => turn.messages.some((m) => m.role !== "user"))]
  return {
    messages: all.flatMap((turn) => turn.messages),
    toolActivities: all.flatMap((turn) => turn.toolActivities),
    subagents: all.flatMap((turn) => turn.subagents),
  }
}

function replayTurn(messages: ChatMessage[], details: SessionTurnDetails = {}): ReplayTurn {
  return {
    messages,
    toolActivities: [...(details.toolActivities ?? [])],
    subagents: [...(details.subagents ?? [])],
  }
}

/** Replays human scrollback. Compaction changes model context, never earlier transcript entries. */
export function replaySessionTranscript(events: readonly SessionEvent[]): SessionTranscriptReplay {
  const turns: (ReplayTurn & { archived?: SessionReplay })[] = []
  for (const event of events) {
    if (event.type === "prompt_admitted") {
      turns.push({
        ...replayTurn([event.message]),
        promptId: event.promptId,
        admittedSeq: event.seq,
      })
    } else if (event.type === "prompt_steered") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) {
        turn.messages.push(event.message)
        turn.steered ??= []
        turn.steered.push(event.message)
      } else turns.push(replayTurn([event.message]))
    } else if (event.type === "compacted") {
      const marker = compactionSummaryMessage(event.summary)
      const turn = event.promptId ? findReplayTurn(turns, event.promptId) : undefined
      if (turn) {
        const pending = (turn.steered ?? []).slice(event.steeringCount)
        const archived = event.turn
          ? {
              messages: [...(turn.archived?.messages ?? []), ...event.turn.messages, marker],
              toolActivities: [
                ...(turn.archived?.toolActivities ?? []),
                ...(event.turn.toolActivities ?? []),
              ],
              subagents: [...(turn.archived?.subagents ?? []), ...(event.turn.subagents ?? [])],
            }
          : {
              // Released checkpoints lack archived turns; preserve the prompt events already
              // replayed.
              messages: [...turn.messages.slice(0, turn.messages.length - pending.length), marker],
              toolActivities: turn.toolActivities,
              subagents: turn.subagents,
            }
        Object.assign(turn, archived, { archived, messages: [...archived.messages, ...pending] })
      } else {
        const queued = turns.findIndex(
          (entry) =>
            event.throughSeq !== undefined &&
            entry.admittedSeq !== undefined &&
            entry.admittedSeq > event.throughSeq,
        )
        turns.splice(queued < 0 ? turns.length : queued, 0, replayTurn([marker]))
      }
    } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) {
        turn.messages = [
          ...(turn.archived?.messages ?? turn.messages.slice(0, 1)),
          ...event.messages,
        ]
        turn.toolActivities = [
          ...(turn.archived?.toolActivities ?? []),
          ...(event.toolActivities ?? []),
        ]
        turn.subagents = [...(turn.archived?.subagents ?? []), ...(event.subagents ?? [])]
      } else turns.push(replayTurn([...event.messages], event))
    }
  }
  return {
    turns: turns.map(({ messages, toolActivities, subagents }) => ({
      messages,
      toolActivities,
      subagents,
    })),
    messages: turns.flatMap((turn) => turn.messages),
    toolActivities: turns.flatMap((turn) => turn.toolActivities),
    subagents: turns.flatMap((turn) => turn.subagents),
  }
}

/**
 * Keeps the records whose delegating tool call still appears in `messages`, e.g. after
 * compaction.
 */
export function forToolCalls<T extends { toolCallId: string }>(
  records: readonly T[],
  messages: readonly ChatMessage[],
) {
  const keptCallIds = new Set(toolCallCounts(messages).keys())
  return records.filter((record) => keptCallIds.has(record.toolCallId))
}

function findReplayTurn<T extends { promptId?: string }>(turns: T[], promptId: string) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.promptId === promptId) return turns[index]
  }
  return undefined
}

export function replaySessionMessages(events: readonly SessionEvent[]) {
  return replaySession(events).messages
}

/** A listing skips files that vanished or cannot be parsed; every other failure surfaces. */
export function isUnreadableSessionFile(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    isNotFoundError(error) ||
    message.startsWith("Invalid session ID:") ||
    message.startsWith("Invalid session JSON at line ") ||
    message.startsWith("Invalid session event at line ") ||
    message.startsWith("Invalid session sequence at line ")
  )
}

export function isNotFoundError(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

function parseSessionEvent(value: unknown, line: number): SessionEvent {
  if (!isRecord(value)) throw invalidEvent(line, "expected object")

  const { seq, sessionId, at, type, promptId } = value
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw invalidEvent(line, "seq must be a positive integer")
  }
  if (typeof sessionId !== "string" || !sessionId)
    throw invalidEvent(line, "sessionId must be a string")
  if (typeof at !== "string" || !at) throw invalidEvent(line, "at must be a string")
  const base = { seq, sessionId, at }

  if (type === "session_started") {
    if (value.version !== 1) throw invalidEvent(line, "session_started version must be 1")
    if (value.cwd !== undefined && typeof value.cwd !== "string")
      throw invalidEvent(line, "cwd must be a string")
    return { ...base, type, version: 1, ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }
  }
  if (
    type === "prompt_admitted" ||
    type === "prompt_steered" ||
    type === "turn_started" ||
    type === "turn_completed" ||
    type === "turn_interrupted"
  ) {
    if (typeof promptId !== "string" || !promptId)
      throw invalidEvent(line, "promptId must be a string")
    if (type === "turn_started") return { ...base, type, promptId }
    if (type === "prompt_admitted" || type === "prompt_steered") {
      const { message } = value
      if (!isChatMessage(message) || message.role !== "user") {
        throw invalidEvent(line, "message must be a user chat message")
      }
      return { ...base, type, promptId, message }
    }
    const messages = parseChatMessages(value.messages, line)
    return { ...base, type, promptId, messages, ...parseTurnDetails(value, messages, line) }
  }
  if (type === "compacted") {
    if (typeof value.summary !== "string" || !value.summary)
      throw invalidEvent(line, "summary must be a string")
    const messages = parseChatMessages(value.messages, line)
    const { throughSeq, steeringCount } = value
    if (
      promptId !== undefined &&
      (typeof promptId !== "string" ||
        !promptId ||
        throughSeq === undefined ||
        nonNegativeInteger(steeringCount) === undefined)
    ) {
      throw invalidEvent(
        line,
        "compacted promptId requires a prompt ID, throughSeq, and steeringCount",
      )
    }
    if (
      throughSeq !== undefined &&
      (typeof throughSeq !== "number" ||
        !Number.isInteger(throughSeq) ||
        throughSeq < 1 ||
        throughSeq >= seq)
    ) {
      throw invalidEvent(line, "compacted throughSeq must reference an earlier event")
    }
    let turn: SessionTurnSegment | undefined
    if (value.turn !== undefined) {
      if (!isRecord(value.turn)) throw invalidEvent(line, "compacted turn must be an object")
      const turnMessages = parseChatMessages(value.turn.messages, line)
      turn = { messages: turnMessages, ...parseTurnDetails(value.turn, turnMessages, line) }
    }
    return {
      ...base,
      type,
      summary: value.summary,
      messages,
      ...(turn ? { turn } : {}),
      ...parseTurnDetails(value, messages, line),
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(promptId === undefined
        ? {}
        : { promptId: promptId as string, steeringCount: steeringCount as number }),
    }
  }
  if (type === "usage_recorded") {
    const { purpose, usage } = value
    if (purpose !== "agent" && purpose !== "compaction" && purpose !== "title") {
      throw invalidEvent(line, "usage purpose was invalid")
    }
    if (promptId !== undefined && (typeof promptId !== "string" || !promptId)) {
      throw invalidEvent(line, "usage promptId must be a non-empty string")
    }
    if (!isRecord(usage)) throw invalidEvent(line, "usage must be an object")
    const promptTokens = nonNegativeInteger(usage.promptTokens)
    const completionTokens = nonNegativeInteger(usage.completionTokens)
    const totalTokens = nonNegativeInteger(usage.totalTokens)
    if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
      throw invalidEvent(line, "usage token counts must be non-negative integers")
    }
    if (totalTokens < promptTokens + completionTokens) {
      throw invalidEvent(line, "usage totalTokens must include prompt and completion tokens")
    }
    return {
      ...base,
      type,
      purpose,
      ...(promptId === undefined ? {} : { promptId }),
      usage: { promptTokens, completionTokens, totalTokens },
    }
  }
  if (type === "title_renamed") {
    if (typeof value.title !== "string" || !value.title.trim()) {
      throw invalidEvent(line, "title must be a non-empty string")
    }
    return { ...base, type, title: value.title.trim() }
  }
  throw invalidEvent(line, "unknown event type")
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function parseChatMessages(value: unknown, line: number): ChatMessage[] {
  if (!Array.isArray(value) || !value.every(isChatMessage))
    throw invalidEvent(line, "messages must be chat messages")
  return value
}

function parseTurnDetails(
  value: Record<string, unknown>,
  messages: ChatMessage[],
  line: number,
): SessionTurnDetails {
  const toolActivities = parseToolActivities(value.toolActivities, messages, line)
  const details: SessionTurnDetails = toolActivities ? { toolActivities } : {}
  if (value.subagents === undefined) return details
  if (!Array.isArray(value.subagents)) throw invalidEvent(line, "subagents must be an array")
  const remainingCalls = toolCallCounts(messages, "agent")
  details.subagents = value.subagents.map((run): SessionSubagentRun => {
    if (!isRecord(run)) throw invalidEvent(line, "subagents entries must be objects")
    const { toolCallId, title, status } = run
    const remaining = typeof toolCallId === "string" ? (remainingCalls.get(toolCallId) ?? 0) : 0
    if (typeof toolCallId !== "string" || remaining === 0) {
      throw invalidEvent(line, "subagent run did not match an agent tool call")
    }
    remainingCalls.set(toolCallId, remaining - 1)
    if (typeof title !== "string" || !title.trim()) {
      throw invalidEvent(line, "subagent run title must be a non-empty string")
    }
    if (status !== "complete" && status !== "failed" && status !== "interrupted") {
      throw invalidEvent(line, "subagent run status was invalid")
    }
    const durationMs = run.durationMs === undefined ? undefined : nonNegativeInteger(run.durationMs)
    if (run.durationMs !== undefined && durationMs === undefined) {
      throw invalidEvent(line, "subagent run durationMs must be a non-negative integer")
    }
    const runMessages = parseChatMessages(run.messages, line)
    const runActivities = parseToolActivities(run.toolActivities, runMessages, line)
    return {
      toolCallId,
      title,
      status,
      messages: runMessages,
      ...(runActivities ? { toolActivities: runActivities } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
  })
  return details
}

function parseToolActivities(
  value: unknown,
  messages: ChatMessage[],
  line: number,
): SessionToolActivity[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalidEvent(line, "toolActivities must be an array")
  const remainingCalls = toolCallCounts(messages)
  return value.map((activity): SessionToolActivity => {
    if (!isRecord(activity)) throw invalidEvent(line, "toolActivities entries must be objects")
    const { toolCallId, activityKind, label, diff, artifact } = activity
    if (typeof toolCallId !== "string" || !toolCallId) {
      throw invalidEvent(line, "tool activity toolCallId must be a non-empty string")
    }
    if (!isToolActivityKind(activityKind))
      throw invalidEvent(line, "tool activity activityKind was invalid")
    if (typeof label !== "string" || !label.trim()) {
      throw invalidEvent(line, "tool activity label must be a non-empty string")
    }
    if (diff !== undefined && typeof diff !== "string")
      throw invalidEvent(line, "tool activity diff must be a string")
    if (artifact !== undefined && !isFileArtifactReference(artifact)) {
      throw invalidEvent(line, "tool activity artifact was invalid")
    }
    const remaining = remainingCalls.get(toolCallId) ?? 0
    if (remaining === 0) throw invalidEvent(line, "tool activity did not match a tool call")
    remainingCalls.set(toolCallId, remaining - 1)
    return {
      toolCallId,
      activityKind,
      label,
      ...(diff === undefined ? {} : { diff }),
      ...(artifact === undefined ? {} : { artifact }),
    }
  })
}

function toolCallCounts(messages: readonly ChatMessage[], name?: string) {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool_call" || (name !== undefined && part.toolCall.name !== name)) continue
      counts.set(part.toolCall.id, (counts.get(part.toolCall.id) ?? 0) + 1)
    }
  }
  return counts
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  if (value.role === "user") return isUserContent(value.content)
  if (value.role === "tool")
    return typeof value.toolCallId === "string" && typeof value.content === "string"
  return (
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    value.content.every(isAssistantContentPart)
  )
}

function isUserContent(value: unknown): value is UserChatMessage["content"] {
  if (typeof value === "string") return true
  if (!Array.isArray(value) || value.length === 0 || !value.every(isUserContentPart)) return false
  const images = value.filter((part): part is ImageContentPart => part.type === "image")
  const documents = value.filter((part): part is DocumentContentPart => part.type === "document")
  return (
    images.length <= MAX_IMAGES_PER_REQUEST &&
    images.reduce((total, image) => total + image.data.length, 0) < MAX_BASE64_IMAGE_BYTES &&
    documents.length <= MAX_DOCUMENTS_PER_MESSAGE &&
    documents.reduce((total, document) => total + document.sizeBytes, 0) <=
      MAX_TOTAL_DOCUMENT_BYTES &&
    documents.reduce((total, document) => total + document.extractedText.length, 0) <=
      MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS
  )
}

function isUserContentPart(value: unknown): value is UserContentPart {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type !== "image" && value.type !== "document") return false
  if (
    typeof value.data !== "string" ||
    typeof value.name !== "string" ||
    !value.name ||
    [...value.name].some(isControlCharacter) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    !isCanonicalBase64(value.data)
  ) {
    return false
  }
  const bytes = Buffer.from(value.data, "base64")
  if (bytes.byteLength !== value.sizeBytes) return false
  if (value.type === "image")
    return typeof value.mimeType === "string" && IMAGE_MIME_TYPES.includes(value.mimeType)
  if (value.kind === "pdf" && (value.mimeType !== PDF_MIME_TYPE || value.pageCount === undefined))
    return false
  if (value.kind === "docx" && value.mimeType !== DOCX_MIME_TYPE) return false
  if (
    value.kind === "text" &&
    (value.mimeType === PDF_MIME_TYPE || value.mimeType === DOCX_MIME_TYPE)
  )
    return false
  return (
    (value.kind === "text" || value.kind === "pdf" || value.kind === "docx") &&
    typeof value.extractedText === "string" &&
    value.extractedText.length > 0 &&
    value.extractedText.length <= MAX_EXTRACTED_DOCUMENT_CHARS &&
    isSupportedDocumentMimeType(value.mimeType) &&
    value.sizeBytes <= MAX_RAW_DOCUMENT_BYTES &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.truncated === "boolean" &&
    (value.pageCount === undefined ||
      (typeof value.pageCount === "number" &&
        Number.isSafeInteger(value.pageCount) &&
        value.pageCount > 0)) &&
    createHash("sha256").update(bytes).digest("hex") === value.sha256
  )
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x1f || codePoint === 0x7f
}

function isCanonicalBase64(value: string) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  return Buffer.from(value, "base64").toString("base64") === value
}

function isAssistantContentPart(value: unknown) {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type === "tool_call") {
    const call = value.toolCall
    return (
      isRecord(call) &&
      typeof call.id === "string" &&
      typeof call.name === "string" &&
      typeof call.arguments === "string"
    )
  }
  const timestamp = (field: unknown) =>
    field === undefined ||
    (typeof field === "string" && field.length > 0 && Number.isFinite(Date.parse(field)))
  return (
    value.type === "reasoning" &&
    typeof value.text === "string" &&
    (value.field === "reasoning_content" ||
      value.field === "reasoning" ||
      value.field === "reasoning_text") &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length > 0)) &&
    timestamp(value.startedAt) &&
    timestamp(value.endedAt)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidEvent(line: number, reason: string) {
  return new Error(`Invalid session event at line ${line}: ${reason}`)
}
