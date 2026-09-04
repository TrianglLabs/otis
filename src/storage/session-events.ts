import { readFile } from "node:fs/promises"
import { compactionSummaryMessage } from "../core/compaction.js"
import type {
  ChatMessage,
  ChatToolCall,
  ImageContentPart,
  ImageMimeType,
  TokenUsage,
  UserChatMessage,
} from "../inference/types.js"
import { isToolActivityKind, type ToolActivityKind } from "../tools/activity.js"

export type { UserChatMessage } from "../inference/types.js"

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
}

export type SessionSubagentStatus = "complete" | "failed" | "interrupted"

/** The full trace of one delegated run, keyed by the parent's `agent` tool call in the same turn. */
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

export type SessionReplay = {
  messages: ChatMessage[]
  toolActivities: SessionToolActivity[]
  subagents: SessionSubagentRun[]
}

export type UsagePurpose = "agent" | "compaction" | "title"

export type NewSessionEvent =
  | { type: "session_started"; version: 1 }
  | { type: "prompt_admitted"; promptId: string; message: UserChatMessage }
  | { type: "prompt_steered"; promptId: string; message: UserChatMessage }
  | ({ type: "turn_completed"; promptId: string; messages: ChatMessage[] } & SessionTurnDetails)
  | ({ type: "turn_interrupted"; promptId: string; messages: ChatMessage[] } & SessionTurnDetails)
  | ({ type: "compacted"; summary: string; messages: ChatMessage[]; throughSeq?: number } & SessionTurnDetails)
  | { type: "usage_recorded"; purpose: UsagePurpose; promptId?: string; usage: TokenUsage }
  | { type: "title_renamed"; title: string }

export type SessionEvent = BaseSessionEvent & NewSessionEvent

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

    try {
      events.push(parseSessionEvent(JSON.parse(line) as unknown, index + 1))
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid session JSON at line ${index + 1}: ${error.message}`)
      }
      throw error
    }
  }

  assertEventSequence(events)
  return events
}

type ReplayTurn = {
  promptId?: string
  admittedSeq?: number
  messages: ChatMessage[]
  toolActivities: SessionToolActivity[]
  subagents: SessionSubagentRun[]
}

export function replaySession(events: readonly SessionEvent[]): SessionReplay {
  let base: ReplayTurn = { messages: [], toolActivities: [], subagents: [] }
  const turns: ReplayTurn[] = []

  for (const event of events) {
    if (event.type === "compacted") {
      base = replayTurn([compactionSummaryMessage(event.summary), ...event.messages], event)
      const throughSeq = event.throughSeq
      const preserved =
        throughSeq === undefined
          ? []
          : turns.filter((turn) => turn.admittedSeq !== undefined && turn.admittedSeq > throughSeq)
      turns.length = 0
      turns.push(...preserved)
    } else if (event.type === "prompt_admitted") {
      turns.push({ ...replayTurn([event.message]), promptId: event.promptId, admittedSeq: event.seq })
    } else if (event.type === "prompt_steered") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) turn.messages.push(event.message)
      else turns.push(replayTurn([event.message]))
    } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      const turn = findReplayTurn(turns, event.promptId)
      if (turn) {
        const completed = replayTurn([turn.messages[0], ...event.messages], event)
        turn.messages = completed.messages
        turn.toolActivities = completed.toolActivities
        turn.subagents = completed.subagents
      } else {
        turns.push(replayTurn([...event.messages], event))
      }
    }
  }

  const all = [base, ...turns]
  return {
    messages: all.flatMap((turn) => turn.messages),
    toolActivities: all.flatMap((turn) => turn.toolActivities),
    subagents: all.flatMap((turn) => turn.subagents),
  }
}

function replayTurn(messages: ChatMessage[], details: SessionTurnDetails = {}): ReplayTurn {
  return { messages, toolActivities: [...(details.toolActivities ?? [])], subagents: [...(details.subagents ?? [])] }
}

/** Keeps the records whose delegating tool call still appears in `messages`, e.g. after compaction. */
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

export function messagesAfterAdmittedPrompt(prompt: UserChatMessage, messages: ChatMessage[]) {
  if (messages[0]?.role === "user" && messages[0].content === prompt.content) return messages.slice(1)
  return messages
}

export function nextSequence(events: readonly SessionEvent[]) {
  return events.length === 0 ? 1 : events[events.length - 1].seq + 1
}

export function isInvalidSessionFileError(error: unknown) {
  const message = errorMessage(error)
  return (
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

  const { seq, sessionId, at, type } = value
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw invalidEvent(line, "seq must be a positive integer")
  }
  if (typeof sessionId !== "string" || !sessionId) throw invalidEvent(line, "sessionId must be a string")
  if (typeof at !== "string" || !at) throw invalidEvent(line, "at must be a string")

  if (type === "session_started") {
    if (value.version !== 1) throw invalidEvent(line, "session_started version must be 1")
    return { seq, sessionId, at, type, version: 1 }
  }
  if (type === "prompt_admitted") {
    if (typeof value.promptId !== "string" || !value.promptId) throw invalidEvent(line, "promptId must be a string")
    if (!isUserMessage(value.message)) throw invalidEvent(line, "message must be a user chat message")
    return { seq, sessionId, at, type, promptId: value.promptId, message: value.message }
  }
  if (type === "prompt_steered") {
    if (typeof value.promptId !== "string" || !value.promptId) throw invalidEvent(line, "promptId must be a string")
    if (!isUserMessage(value.message)) throw invalidEvent(line, "message must be a user chat message")
    return { seq, sessionId, at, type, promptId: value.promptId, message: value.message }
  }
  if (type === "turn_completed" || type === "turn_interrupted") {
    if (typeof value.promptId !== "string" || !value.promptId) throw invalidEvent(line, "promptId must be a string")
    const messages = parseChatMessages(value.messages, line)
    return {
      seq,
      sessionId,
      at,
      type,
      promptId: value.promptId,
      messages,
      ...parseTurnDetails(value, messages, line),
    }
  }
  if (type === "compacted") {
    if (typeof value.summary !== "string" || !value.summary) throw invalidEvent(line, "summary must be a string")
    const messages = parseChatMessages(value.messages, line)
    if (
      value.throughSeq !== undefined &&
      (typeof value.throughSeq !== "number" ||
        !Number.isInteger(value.throughSeq) ||
        value.throughSeq < 1 ||
        value.throughSeq >= seq)
    ) {
      throw invalidEvent(line, "compacted throughSeq must reference an earlier event")
    }
    return {
      seq,
      sessionId,
      at,
      type,
      summary: value.summary,
      messages,
      ...parseTurnDetails(value, messages, line),
      ...(value.throughSeq === undefined ? {} : { throughSeq: value.throughSeq }),
    }
  }
  if (type === "usage_recorded") {
    if (!isUsagePurpose(value.purpose)) throw invalidEvent(line, "usage purpose was invalid")
    if (value.promptId !== undefined && (typeof value.promptId !== "string" || !value.promptId)) {
      throw invalidEvent(line, "usage promptId must be a non-empty string")
    }
    const usage = parseTokenUsage(value.usage, line)
    return {
      seq,
      sessionId,
      at,
      type,
      purpose: value.purpose,
      ...(value.promptId === undefined ? {} : { promptId: value.promptId }),
      usage,
    }
  }
  if (type === "title_renamed") {
    if (typeof value.title !== "string" || !value.title.trim()) {
      throw invalidEvent(line, "title must be a non-empty string")
    }
    return { seq, sessionId, at, type, title: value.title.trim() }
  }
  throw invalidEvent(line, "unknown event type")
}

function parseTokenUsage(value: unknown, line: number): TokenUsage {
  if (!isRecord(value)) throw invalidEvent(line, "usage must be an object")
  const promptTokens = nonNegativeInteger(value.promptTokens)
  const completionTokens = nonNegativeInteger(value.completionTokens)
  const totalTokens = nonNegativeInteger(value.totalTokens)
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    throw invalidEvent(line, "usage token counts must be non-negative integers")
  }
  if (totalTokens < promptTokens + completionTokens) {
    throw invalidEvent(line, "usage totalTokens must include prompt and completion tokens")
  }
  return { promptTokens, completionTokens, totalTokens }
}

function isUsagePurpose(value: unknown): value is UsagePurpose {
  return value === "agent" || value === "compaction" || value === "title"
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function parseChatMessages(value: unknown, line: number): ChatMessage[] {
  if (!Array.isArray(value) || !value.every(isChatMessage)) throw invalidEvent(line, "messages must be chat messages")
  return value
}

function parseTurnDetails(value: Record<string, unknown>, messages: ChatMessage[], line: number): SessionTurnDetails {
  const toolActivities = parseToolActivities(value.toolActivities, messages, line)
  const subagents = parseSubagentRuns(value.subagents, messages, line)
  return { ...(toolActivities ? { toolActivities } : {}), ...(subagents ? { subagents } : {}) }
}

function parseToolActivities(value: unknown, messages: ChatMessage[], line: number): SessionToolActivity[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalidEvent(line, "toolActivities must be an array")
  const remainingCalls = toolCallCounts(messages)

  return value.map((activity) => {
    if (!isRecord(activity)) throw invalidEvent(line, "toolActivities entries must be objects")
    if (typeof activity.toolCallId !== "string" || !activity.toolCallId) {
      throw invalidEvent(line, "tool activity toolCallId must be a non-empty string")
    }
    if (!isToolActivityKind(activity.activityKind)) {
      throw invalidEvent(line, "tool activity activityKind was invalid")
    }
    if (typeof activity.label !== "string" || !activity.label.trim()) {
      throw invalidEvent(line, "tool activity label must be a non-empty string")
    }
    if (activity.diff !== undefined && typeof activity.diff !== "string") {
      throw invalidEvent(line, "tool activity diff must be a string")
    }
    const remaining = remainingCalls.get(activity.toolCallId) ?? 0
    if (remaining === 0) throw invalidEvent(line, "tool activity did not match a tool call")
    remainingCalls.set(activity.toolCallId, remaining - 1)

    return {
      toolCallId: activity.toolCallId,
      activityKind: activity.activityKind,
      label: activity.label,
      ...(activity.diff !== undefined ? { diff: activity.diff } : {}),
    }
  })
}

function parseSubagentRuns(value: unknown, messages: ChatMessage[], line: number): SessionSubagentRun[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalidEvent(line, "subagents must be an array")
  const remainingCalls = toolCallCounts(messages, "agent")

  return value.map((run) => {
    if (!isRecord(run)) throw invalidEvent(line, "subagents entries must be objects")
    const { toolCallId } = run
    const remaining = typeof toolCallId === "string" ? (remainingCalls.get(toolCallId) ?? 0) : 0
    if (typeof toolCallId !== "string" || remaining === 0) {
      throw invalidEvent(line, "subagent run did not match an agent tool call")
    }
    remainingCalls.set(toolCallId, remaining - 1)
    if (typeof run.title !== "string" || !run.title.trim()) {
      throw invalidEvent(line, "subagent run title must be a non-empty string")
    }
    if (!isSubagentStatus(run.status)) throw invalidEvent(line, "subagent run status was invalid")
    const durationMs = run.durationMs === undefined ? undefined : nonNegativeInteger(run.durationMs)
    if (run.durationMs !== undefined && durationMs === undefined) {
      throw invalidEvent(line, "subagent run durationMs must be a non-negative integer")
    }
    const runMessages = parseChatMessages(run.messages, line)
    const toolActivities = parseToolActivities(run.toolActivities, runMessages, line)

    return {
      toolCallId,
      title: run.title,
      status: run.status,
      messages: runMessages,
      ...(toolActivities ? { toolActivities } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
  })
}

function isSubagentStatus(value: unknown): value is SessionSubagentStatus {
  return value === "complete" || value === "failed" || value === "interrupted"
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

function assertEventSequence(events: readonly SessionEvent[]) {
  let previousSeq = 0
  let sessionId: string | undefined

  for (const [index, event] of events.entries()) {
    const line = index + 1
    if (event.seq !== previousSeq + 1) {
      throw new Error(`Invalid session sequence at line ${line}: expected ${previousSeq + 1}`)
    }
    if (sessionId && event.sessionId !== sessionId) {
      throw new Error(`Invalid session event at line ${line}: sessionId changed`)
    }
    sessionId = event.sessionId
    previousSeq = event.seq
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  if (value.role === "user") return isUserContent(value.content)
  if (value.role === "tool" && typeof value.toolCallId === "string" && typeof value.content === "string") return true
  return value.role === "assistant" && Array.isArray(value.content) && value.content.every(isAssistantContentPart)
}

function isUserMessage(value: unknown): value is UserChatMessage {
  return isRecord(value) && value.role === "user" && isUserContent(value.content)
}

function isUserContent(value: unknown): value is UserChatMessage["content"] {
  return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every(isUserContentPart))
}

function isUserContentPart(value: unknown): value is { type: "text"; text: string } | ImageContentPart {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type !== "image") return false
  if (
    typeof value.data !== "string" ||
    !isImageMimeType(value.mimeType) ||
    typeof value.name !== "string" ||
    !value.name ||
    [...value.name].some(isControlCharacter) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0
  ) {
    return false
  }
  return isCanonicalBase64(value.data) && Buffer.from(value.data, "base64").byteLength === value.sizeBytes
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x1f || codePoint === 0x7f
}

function isCanonicalBase64(value: string) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  return Buffer.from(value, "base64").toString("base64") === value
}

function isImageMimeType(value: unknown): value is ImageMimeType {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/gif" ||
    value === "image/bmp" ||
    value === "image/tiff" ||
    value === "image/x-portable-pixmap"
  )
}

function isAssistantContentPart(value: unknown) {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type === "reasoning") {
    return (
      typeof value.text === "string" &&
      isReasoningField(value.field) &&
      optionalString(value.id) &&
      optionalTimestamp(value.startedAt) &&
      optionalTimestamp(value.endedAt)
    )
  }
  return value.type === "tool_call" && isChatToolCall(value.toolCall)
}

function optionalString(value: unknown) {
  return value === undefined || (typeof value === "string" && value.length > 0)
}

function optionalTimestamp(value: unknown) {
  return value === undefined || (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)))
}

function isReasoningField(value: unknown) {
  return value === "reasoning_content" || value === "reasoning" || value === "reasoning_text"
}

function isChatToolCall(value: unknown): value is ChatToolCall {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.arguments === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidEvent(line: number, reason: string) {
  return new Error(`Invalid session event at line ${line}: ${reason}`)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
