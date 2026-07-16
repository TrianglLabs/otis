import { randomUUID } from "node:crypto"
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { isCompactionSummary } from "../core/compaction.js"
import type { ChatMessage, TokenUsage } from "../inference/types.js"
import {
  type BaseSessionEvent,
  isInvalidSessionFileError,
  isNotFoundError,
  messagesAfterAdmittedPrompt,
  type NewSessionEvent,
  nextSequence,
  readSessionEvents,
  replaySession,
  replaySessionMessages,
  type SessionEvent,
  type SessionToolActivity,
  type UsagePurpose,
  type UserChatMessage,
} from "./session-events.js"
import {
  appendJsonLine,
  assertSessionId,
  defaultSessionDirectory,
  sessionDirectory,
  sessionFile,
} from "./session-files.js"
import type { PromptAdmission, SessionOptions, SessionSummary } from "./session-types.js"

export const DEFAULT_SESSION_ID = "default"

export class JsonlSession {
  readonly events: SessionEvent[]
  private nextSeq: number
  private appendQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    readonly filePath: string,
    events: SessionEvent[] = [],
  ) {
    this.events = [...events]
    this.nextSeq = nextSequence(this.events)
  }

  replayMessages() {
    return replaySessionMessages(this.events)
  }

  replay() {
    return replaySession(this.events)
  }

  async admitPrompt(content: string): Promise<PromptAdmission> {
    const event = await this.append({
      type: "prompt_admitted",
      promptId: newEventId("prompt"),
      message: { role: "user", content },
    })
    return { promptId: event.promptId, message: event.message }
  }

  completeTurn(admission: PromptAdmission, turnMessages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    return this.append({
      type: "turn_completed",
      promptId: admission.promptId,
      messages: messagesAfterAdmittedPrompt(admission.message, turnMessages),
      ...(toolActivities.length > 0 ? { toolActivities } : {}),
    })
  }

  compact(summary: string, messages: ChatMessage[], toolActivities: SessionToolActivity[] = []) {
    return this.append({
      type: "compacted",
      summary,
      messages,
      ...(toolActivities.length > 0 ? { toolActivities } : {}),
    })
  }

  recordUsage(usage: TokenUsage, purpose: UsagePurpose, promptId?: string) {
    return this.append({ type: "usage_recorded", purpose, ...(promptId ? { promptId } : {}), usage })
  }

  renameTitle(title: string) {
    return this.append({ type: "title_renamed", title })
  }

  hasTitle() {
    return this.events.some((event) => event.type === "title_renamed")
  }

  title() {
    return sessionTitleFromEvents(this.events, this.replayMessages())
  }

  async start() {
    if (this.events.length === 0) await this.append({ type: "session_started", version: 1 })
  }

  private append<T extends NewSessionEvent>(event: T): Promise<BaseSessionEvent & T> {
    const write = this.appendQueue.then(() => this.writeEvent(event))
    this.appendQueue = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  private async writeEvent<T extends NewSessionEvent>(event: T): Promise<BaseSessionEvent & T> {
    const persisted = {
      seq: this.nextSeq,
      sessionId: this.id,
      at: new Date().toISOString(),
      ...event,
    }
    await appendJsonLine(this.filePath, JSON.stringify(persisted))
    this.events.push(persisted as SessionEvent)
    this.nextSeq += 1
    return persisted
  }
}

export async function openSession(options: SessionOptions) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID
  assertSessionId(sessionId)

  const filePath = sessionFile(options, sessionId)
  const session = new JsonlSession(sessionId, filePath, await readSessionEvents(filePath))
  await session.start()
  return session
}

export function createSession(options: Omit<SessionOptions, "sessionId">) {
  return openSession({ ...options, sessionId: newSessionId() })
}

export async function deleteSession(options: SessionOptions) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID
  assertSessionId(sessionId)
  await rm(sessionFile(options, sessionId), { force: true })
}

export async function listSessions(options: Omit<SessionOptions, "sessionId">): Promise<SessionSummary[]> {
  let fileNames: string[]
  try {
    fileNames = await readdir(sessionDirectory(options))
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const summaries: SessionSummary[] = []
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".jsonl")) continue
    try {
      summaries.push(await summarizeSessionFile(options, fileName))
    } catch (error) {
      if (isNotFoundError(error) || isInvalidSessionFileError(error)) continue
      throw error
    }
  }

  return summaries.sort((left, right) => {
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return updated || right.mtimeMs - left.mtimeMs
  })
}

async function summarizeSessionFile(
  options: Omit<SessionOptions, "sessionId">,
  fileName: string,
): Promise<SessionSummary> {
  const id = fileName.slice(0, -".jsonl".length)
  assertSessionId(id)

  const filePath = join(sessionDirectory(options), fileName)
  const events = await readSessionEvents(filePath)
  const messages = replaySessionMessages(events)
  const fileStat = await stat(filePath)
  return {
    id,
    title: sessionTitleFromEvents(events, messages),
    messageCount: messages.length,
    updatedAt: events.at(-1)?.at ?? new Date(0).toISOString(),
    mtimeMs: fileStat.mtimeMs,
  }
}

function sessionTitleFromEvents(events: readonly SessionEvent[], messages: readonly ChatMessage[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === "title_renamed") return event.title
  }

  const firstUser = messages.find(
    (message): message is UserChatMessage => message.role === "user" && !isCompactionSummary(message),
  )
  return firstUser?.content.trim().split("\n")[0]?.trim() || "Current session"
}

function newEventId(prefix: string) {
  return `${prefix}_${randomUUID()}`
}

function newSessionId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
  return `session_${timestamp}_${randomUUID().slice(0, 8)}`
}

export type { PromptAdmission, SessionEvent, SessionOptions, SessionSummary, SessionToolActivity, UsagePurpose }
export { defaultSessionDirectory, readSessionEvents, replaySession, replaySessionMessages }
