import { readFile } from "node:fs/promises"
import { compactionSummaryMessage } from "../core/compaction.js"
import type { ChatMessage, ChatToolCall, TokenUsage } from "../inference/types.js"
import { isToolActivityKind, type ToolActivityKind } from "../tools/activity.js"

export type UserChatMessage = { role: "user"; content: string }

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

export type SessionReplay = {
  messages: ChatMessage[]
  toolActivities: SessionToolActivity[]
}

export type UsagePurpose = "agent" | "compaction" | "title"

export type SessionEvent =
  | (BaseSessionEvent & { type: "session_started"; version: 1 })
  | (BaseSessionEvent & { type: "prompt_admitted"; promptId: string; message: UserChatMessage })
  | (BaseSessionEvent & {
      type: "turn_completed"
      promptId: string
      messages: ChatMessage[]
      toolActivities?: SessionToolActivity[]
    })
  | (BaseSessionEvent & {
      type: "turn_interrupted"
      promptId: string
      messages: ChatMessage[]
      toolActivities?: SessionToolActivity[]
    })
  | (BaseSessionEvent & {
      type: "compacted"
      summary: string
      messages: ChatMessage[]
      toolActivities?: SessionToolActivity[]
    })
  | (BaseSessionEvent & {
      type: "usage_recorded"
      purpose: UsagePurpose
      promptId?: string
      usage: TokenUsage
    })
  | (BaseSessionEvent & { type: "title_renamed"; title: string })

export type NewSessionEvent =
  | { type: "session_started"; version: 1 }
  | { type: "prompt_admitted"; promptId: string; message: UserChatMessage }
  | {
      type: "turn_completed"
      promptId: string
      messages: ChatMessage[]
      toolActivities?: SessionToolActivity[]
    }
  | {
      type: "turn_interrupted"
      promptId: string
      messages: ChatMessage[]
      toolActivities?: SessionToolActivity[]
    }
  | { type: "compacted"; summary: string; messages: ChatMessage[]; toolActivities?: SessionToolActivity[] }
  | { type: "usage_recorded"; purpose: UsagePurpose; promptId?: string; usage: TokenUsage }
  | { type: "title_renamed"; title: string }

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

export function replaySession(events: readonly SessionEvent[]): SessionReplay {
  const messages: ChatMessage[] = []
  const toolActivities: SessionToolActivity[] = []

  for (const event of events) {
    if (event.type === "compacted") {
      messages.length = 0
      toolActivities.length = 0
      messages.push(compactionSummaryMessage(event.summary), ...event.messages)
      toolActivities.push(...(event.toolActivities ?? []))
    } else if (event.type === "prompt_admitted") {
      messages.push(event.message)
    } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
      messages.push(...event.messages)
      toolActivities.push(...(event.toolActivities ?? []))
    }
  }

  return { messages, toolActivities }
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
  if (type === "turn_completed" || type === "turn_interrupted") {
    if (typeof value.promptId !== "string" || !value.promptId) throw invalidEvent(line, "promptId must be a string")
    if (!Array.isArray(value.messages) || !value.messages.every(isChatMessage)) {
      throw invalidEvent(line, "messages must be chat messages")
    }
    const toolActivities = parseToolActivities(value.toolActivities, value.messages, line)
    return {
      seq,
      sessionId,
      at,
      type,
      promptId: value.promptId,
      messages: value.messages,
      ...(toolActivities ? { toolActivities } : {}),
    }
  }
  if (type === "compacted") {
    if (typeof value.summary !== "string" || !value.summary) throw invalidEvent(line, "summary must be a string")
    if (!Array.isArray(value.messages) || !value.messages.every(isChatMessage)) {
      throw invalidEvent(line, "messages must be chat messages")
    }
    const toolActivities = parseToolActivities(value.toolActivities, value.messages, line)
    return {
      seq,
      sessionId,
      at,
      type,
      summary: value.summary,
      messages: value.messages,
      ...(toolActivities ? { toolActivities } : {}),
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
  if (value.role === "user" && typeof value.content === "string") return true
  if (value.role === "tool" && typeof value.toolCallId === "string" && typeof value.content === "string") return true
  return value.role === "assistant" && Array.isArray(value.content) && value.content.every(isAssistantContentPart)
}

function isUserMessage(value: unknown): value is UserChatMessage {
  return isRecord(value) && value.role === "user" && typeof value.content === "string"
}

function isAssistantContentPart(value: unknown) {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type === "reasoning") return typeof value.text === "string" && isReasoningField(value.field)
  return value.type === "tool_call" && isChatToolCall(value.toolCall)
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
