import { randomUUID } from "node:crypto"
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { isCompactionSummary } from "../core/compaction.js"
import { createUserMessage, summarizeUserMessage, userMessageText } from "../inference/messages.js"
import type { ChatMessage, TokenUsage, UserChatMessage } from "../inference/types.js"
import {
  type BaseSessionEvent,
  isNotFoundError,
  isUnreadableSessionFile,
  type NewSessionEvent,
  readSessionEvents,
  replaySession,
  replaySessionMessages,
  replaySessionTranscript,
  type SessionEvent,
  type SessionTurnDetails,
  type SessionTurnSegment,
  type UsagePurpose,
} from "./session-events.js"
import {
  appendJsonLine,
  assertSessionId,
  defaultSessionDirectory,
  type SessionOptions,
  sessionDirectory,
  sessionFile,
} from "./session-files.js"
import { listWorkspaceSessionDirs, registerWorkspacePath } from "./workspace-registry.js"

const DEFAULT_SESSION_ID = "default"

export type PromptAdmission = {
  promptId: string
  message: UserChatMessage
}

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
}

type SessionSearchResult = SessionSummary & {
  /** The first content match, flattened to one line with context; absent for title-only hits. */
  snippet?: string
}

/**
 * Global session history rows carry the storage dir name (identity when ids repeat across
 * workspaces) and the registered workspace path when known — pre-registration history reports
 * `workspacePath: undefined` so callers can offer location.
 */
type GlobalSessionSummary = SessionSummary & {
  dirName: string
  workspacePath?: string
}

type GlobalSessionSearchResult = GlobalSessionSummary & { snippet?: string }

/**
 * Fallback titles derive from the first user message, which can be a pasted paragraph — cap them
 * so pickers and headers stay neat. Mirrors GENERATED_TITLE_MAX_LENGTH in src/app/sessions.ts
 * (storage can't import app).
 */
const FALLBACK_TITLE_MAX_LENGTH = 60

export class JsonlSession {
  private appendQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    readonly filePath: string,
    readonly events: SessionEvent[],
  ) {}

  /** A session owns its copies even when opened from a relocated history directory. */
  get artifactDirectory() {
    return `${this.filePath}.artifacts`
  }

  replayMessages() {
    return replaySessionMessages(this.events)
  }

  replay() {
    return replaySession(this.events)
  }

  replayTranscript() {
    return replaySessionTranscript(this.events)
  }

  async admitPrompt(prompt: string | UserChatMessage): Promise<PromptAdmission> {
    const message = typeof prompt === "string" ? createUserMessage(prompt) : prompt
    const promptId = `prompt_${randomUUID()}`
    await this.append({ type: "prompt_admitted", promptId, message })
    return { promptId, message }
  }

  async steerPrompt(admission: PromptAdmission, prompt: string | UserChatMessage) {
    const message = typeof prompt === "string" ? createUserMessage(prompt) : prompt
    await this.append({ type: "prompt_steered", promptId: admission.promptId, message })
    return message
  }

  /** Admission may queue work; this event marks when that work actually begins. */
  startTurn(admission: PromptAdmission) {
    return this.append({ type: "turn_started", promptId: admission.promptId })
  }

  completeTurn(
    admission: PromptAdmission,
    turnMessages: ChatMessage[],
    details: SessionTurnDetails = {},
  ) {
    return this.append({
      type: "turn_completed",
      promptId: admission.promptId,
      messages: this.continuationMessages(admission, turnMessages),
      ...presentTurnDetails(details),
    })
  }

  interruptTurn(
    admission: PromptAdmission,
    turnMessages: ChatMessage[],
    details: SessionTurnDetails = {},
  ) {
    return this.append({
      type: "turn_interrupted",
      promptId: admission.promptId,
      messages: this.continuationMessages(admission, turnMessages),
      ...presentTurnDetails(details),
    })
  }

  compact(
    summary: string,
    messages: ChatMessage[],
    details: SessionTurnDetails = {},
    throughSeq?: number,
  ) {
    return this.append({
      type: "compacted",
      summary,
      messages,
      ...presentTurnDetails(details),
      ...(throughSeq === undefined ? {} : { throughSeq }),
    })
  }

  /** Checkpoints an active turn, leaving later queued prompts outside its context. */
  compactTurn(
    admission: PromptAdmission,
    summary: string,
    messages: ChatMessage[],
    details: SessionTurnDetails,
    steeringCount: number,
    turn: SessionTurnSegment,
  ) {
    const admitted = this.events.find(
      (event) => event.type === "prompt_admitted" && event.promptId === admission.promptId,
    )
    if (!admitted) throw new Error("Cannot compact a turn without its admitted prompt.")
    return this.append({
      type: "compacted",
      promptId: admission.promptId,
      throughSeq: admitted.seq,
      steeringCount,
      turn: { messages: turn.messages, ...presentTurnDetails(turn) },
      summary,
      messages,
      ...presentTurnDetails(details),
    })
  }

  recordUsage(usage: TokenUsage, purpose: UsagePurpose, promptId?: string) {
    return this.append({
      type: "usage_recorded",
      purpose,
      ...(promptId ? { promptId } : {}),
      usage,
    })
  }

  renameTitle(title: string) {
    return this.append({ type: "title_renamed", title })
  }

  hasTitle() {
    return this.events.some((event) => event.type === "title_renamed")
  }

  title() {
    return sessionTitle(this.events)
  }

  /** Appends one event with the next sequence number; concurrent appends write in call order. */
  append<T extends NewSessionEvent>(event: T): Promise<BaseSessionEvent & T> {
    const write = this.appendQueue.then(async () => {
      const seq = (this.events.at(-1)?.seq ?? 0) + 1
      const persisted = { seq, sessionId: this.id, at: new Date().toISOString(), ...event }
      await appendJsonLine(this.filePath, JSON.stringify(persisted))
      this.events.push(persisted as SessionEvent)
      return persisted
    })
    this.appendQueue = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  private continuationMessages(admission: PromptAdmission, messages: ChatMessage[]) {
    const checkpointed = this.events.some(
      (event) => event.type === "compacted" && event.promptId === admission.promptId,
    )
    if (checkpointed) return messages
    const [first, ...rest] = messages
    return first?.role === "user" && first.content === admission.message.content ? rest : messages
  }
}

export async function openSession(options: SessionOptions) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID
  assertSessionId(sessionId)

  // A real cwd (not a bare directory override) registers the workspace for global history;
  // pre-existing session dirs gain their marker the first time they're opened from a known
  // location.
  if (!options.directory)
    await registerWorkspacePath(defaultSessionDirectory(options.cwd), options.cwd)

  const filePath = sessionFile(options, sessionId)
  const session = new JsonlSession(sessionId, filePath, await readSessionEvents(filePath))
  if (session.events.length === 0) {
    await session.append({
      type: "session_started",
      version: 1,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })
  }
  return session
}

export function createSession(options: Omit<SessionOptions, "sessionId">) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
  return openSession({ ...options, sessionId: `session_${timestamp}_${randomUUID().slice(0, 8)}` })
}

export async function deleteSession(options: SessionOptions) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID
  assertSessionId(sessionId)
  const file = sessionFile(options, sessionId)
  // Remove owned copies first: a cleanup failure must not silently orphan them by deleting their
  // session.
  await rm(`${file}.artifacts`, { recursive: true, force: true })
  await rm(file, { force: true })
}

export async function listSessions(
  options: Omit<SessionOptions, "sessionId">,
): Promise<SessionSummary[]> {
  const directory = sessionDirectory(options)
  let fileNames: string[]
  try {
    fileNames = await readdir(directory)
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const summaries: SessionSummary[] = []
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".jsonl")) continue
    try {
      const id = fileName.slice(0, -".jsonl".length)
      assertSessionId(id)
      const filePath = join(directory, fileName)
      const events = await readSessionEvents(filePath)
      summaries.push({
        id,
        title: sessionTitle(events),
        messageCount: replaySessionMessages(events).length,
        updatedAt: events.at(-1)?.at ?? new Date(0).toISOString(),
        mtimeMs: (await stat(filePath)).mtimeMs,
        state: sessionState(events),
      })
    } catch (error) {
      if (isUnreadableSessionFile(error)) continue
      throw error
    }
  }
  return summaries.sort(byRecency)
}

/**
 * Title-first substring search over sessions, recency-ordered. Title hits rank above content hits,
 * which carry a snippet from the first matching message. Compaction summaries are excluded from
 * the searchable text.
 */
export async function searchSessions(
  options: Omit<SessionOptions, "sessionId">,
  query: string,
): Promise<SessionSearchResult[]> {
  const needle = query.trim().toLowerCase()
  const summaries = await listSessions(options)
  if (!needle) return summaries

  const titleHits: SessionSearchResult[] = []
  const contentHits: SessionSearchResult[] = []
  for (const summary of summaries) {
    if (summary.title.toLowerCase().includes(needle)) {
      titleHits.push(summary)
      continue
    }
    try {
      const events = await readSessionEvents(join(sessionDirectory(options), `${summary.id}.jsonl`))
      // Search the full transcript, not the model-context replay: compaction drops pre-compaction
      // messages from the model's view, but the user's original text is still on disk and should
      // stay searchable.
      for (const message of replaySessionTranscript(events).messages) {
        if (message.role === "tool" || isCompactionSummary(message)) continue
        const text = (
          message.role === "user"
            ? userMessageText(message)
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        )
          .replace(/\s+/g, " ")
          .trim()
        const index = text.toLowerCase().indexOf(needle)
        if (index === -1) continue
        const from = Math.max(0, index - 40)
        const to = Math.min(text.length, index + needle.length + 80)
        const snippet = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`
        contentHits.push({ ...summary, snippet })
        break
      }
    } catch (error) {
      if (isUnreadableSessionFile(error)) continue
      throw error
    }
  }
  return [...titleHits, ...contentHits]
}

/** Every workspace's sessions under the shared data root, merged and recency-ordered. */
export function listAllSessions(
  options: { seeds?: string[] } = {},
): Promise<GlobalSessionSummary[]> {
  return acrossWorkspaces(options.seeds, listSessions)
}

/** Title-first search across every workspace's sessions, ranked like single-workspace search. */
export async function searchAllSessions(
  query: string,
  options: { seeds?: string[] } = {},
): Promise<GlobalSessionSearchResult[]> {
  const hits = await acrossWorkspaces(options.seeds, (directory) =>
    searchSessions(directory, query),
  )
  // Title hits before content hits within each dir's results; keep that ordering after the merge.
  return hits.sort(
    (left, right) => Number(left.snippet !== undefined) - Number(right.snippet !== undefined),
  )
}

async function acrossWorkspaces<T extends SessionSummary>(
  seeds: string[] | undefined,
  list: (options: Omit<SessionOptions, "sessionId">) => Promise<T[]>,
): Promise<(T & { dirName: string; workspacePath?: string })[]> {
  const dirs = await listWorkspaceSessionDirs(seeds)
  const grouped = await Promise.all(
    dirs.map(async ({ dir, dirName, workspacePath }) => {
      try {
        const rows = await list({ cwd: "", directory: dir })
        return rows.map((row) => ({ ...row, dirName, ...(workspacePath ? { workspacePath } : {}) }))
      } catch {
        return [] // a corrupt or half-written dir must not sink the whole list
      }
    }),
  )
  return grouped.flat().sort(byRecency)
}

function byRecency(left: SessionSummary, right: SessionSummary) {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.mtimeMs - left.mtimeMs
}

/** Falls back to the first prompt in model history, or in scrollback when none was answered. */
function sessionTitle(events: readonly SessionEvent[]) {
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

/** Omits empty detail lists so persisted turns stay compact. */
function presentTurnDetails(details: SessionTurnDetails): SessionTurnDetails {
  return {
    ...(details.toolActivities?.length ? { toolActivities: details.toolActivities } : {}),
    ...(details.subagents?.length ? { subagents: details.subagents } : {}),
  }
}
