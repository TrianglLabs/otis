import { randomUUID } from "node:crypto"
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createUserMessage } from "../inference/messages.js"
import {
  addUsage,
  type ChatMessage,
  emptyUsage,
  type ModelProvider,
  type SessionUsage,
  type TokenUsage,
  type UserChatMessage,
} from "../inference/types.js"
import {
  type BaseSessionEvent,
  isNotFoundError,
  isUnreadableSessionFile,
  type NewSessionEvent,
  readSessionEvents,
  recordedUsage,
  replaySession,
  replaySessionMessages,
  replaySessionTranscript,
  type SessionEvent,
  type SessionTurnDetails,
  type SessionTurnSegment,
  type SessionView,
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
import {
  forgetSessionDigest,
  readSessionDigest,
  type SessionDigest,
  type SessionSummary,
  sessionTitle,
  sessionView,
} from "./session-index.js"
import { listWorkspaceSessionDirs, registerWorkspacePath } from "./workspace-registry.js"

export type { SessionState, SessionSummary } from "./session-index.js"

const DEFAULT_SESSION_ID = "default"

export type PromptAdmission = {
  promptId: string
  message: UserChatMessage
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

  recordUsage(
    usage: TokenUsage,
    purpose: UsagePurpose,
    {
      promptId,
      provider,
      model,
      modelName,
    }: { promptId?: string; provider?: ModelProvider; model?: string; modelName?: string } = {},
  ) {
    return this.append({
      type: "usage_recorded",
      purpose,
      ...(promptId ? { promptId } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(modelName ? { modelName } : {}),
      usage,
    })
  }

  renameTitle(title: string) {
    return this.append({ type: "title_renamed", title })
  }

  /** The arrangement this session was last on screen in, or none recorded. */
  view(): SessionView | undefined {
    return sessionView(this.events)
  }

  /** Records a changed arrangement; one already on file is not repeated. */
  async arrangeView(view: SessionView) {
    const current = this.view()
    const same =
      current?.axis === view.axis &&
      current.members.length === view.members.length &&
      current.members.every(
        (member, index) =>
          member.id === view.members[index].id && member.dirName === view.members[index].dirName,
      )
    // A session never arranged is alone, which a view of one merely restates.
    if (same || (!current && view.members.length === 1)) return
    await this.append({ type: "view_arranged", ...view })
  }

  hasTitle() {
    return this.events.some((event) => event.type === "title_renamed")
  }

  /** Every recorded request, title generation and compaction included. */
  usage(): SessionUsage {
    const records = recordedUsage(this.events)
    return {
      last: records.at(-1)?.usage ?? null,
      total: records.reduce((total, record) => addUsage(total, record.usage), emptyUsage()),
    }
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
  forgetSessionDigest(file)
}

export async function listSessions(
  options: Omit<SessionOptions, "sessionId">,
): Promise<SessionSummary[]> {
  return (await digestSessions(options)).map((session) => session.summary)
}

export async function searchSessions(
  options: Omit<SessionOptions, "sessionId">,
  query: string,
): Promise<SessionSearchResult[]> {
  return matchSessions(await digestSessions(options, true), query)
}

/** Every workspace's sessions under the shared data root, merged and recency-ordered. */
export async function listAllSessions(
  options: { seeds?: string[] } = {},
): Promise<GlobalSessionSummary[]> {
  return (await digestAllSessions(options.seeds)).map((session) => session.summary)
}

/** With `words`, every word of the query counts on its own, as recall asks; else the phrase. */
export async function searchAllSessions(
  query: string,
  options: { seeds?: string[]; words?: boolean } = {},
): Promise<GlobalSessionSearchResult[]> {
  return matchSessions(await digestAllSessions(options.seeds, true), query, options.words)
}

/**
 * What a search looks for: the phrase as typed, or each word of three letters or more on its
 * own and whole, so "me" never finds "memory". Case never matters.
 */
export function searchNeedles(query: string, words = false): RegExp[] {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  if (!words) {
    const phrase = query.trim()
    return phrase ? [new RegExp(literal(phrase), "iu")] : []
  }
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].map(
    (word) => new RegExp(`(?<![\\p{L}\\p{N}])${literal(word)}(?![\\p{L}\\p{N}])`, "iu"),
  )
}

/** Every readable session in a dir with its digest, newest first; other errors surface. */
async function digestSessions(options: Omit<SessionOptions, "sessionId">, texts = false) {
  const directory = sessionDirectory(options)
  let fileNames: string[]
  try {
    fileNames = await readdir(directory)
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }
  const sessions: (SessionDigest & { summary: SessionSummary })[] = []
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".jsonl")) continue
    try {
      const id = fileName.slice(0, -".jsonl".length)
      assertSessionId(id)
      const digest = await readSessionDigest(join(directory, fileName), texts)
      sessions.push({ ...digest, summary: { id, ...digest.summary } })
    } catch (error) {
      if (isUnreadableSessionFile(error)) continue
      throw error
    }
  }
  return sessions.sort((left, right) => byRecency(left.summary, right.summary))
}

/** Every workspace's sessions with their digests, newest first across workspaces. */
export async function digestAllSessions(seeds: string[] | undefined, texts = false) {
  const dirs = await listWorkspaceSessionDirs(seeds)
  const grouped = await Promise.all(
    dirs.map(async ({ dir, dirName, workspacePath }) => {
      try {
        const sessions = await digestSessions({ cwd: "", directory: dir }, texts)
        return sessions.map((session) => ({
          ...session,
          summary: { ...session.summary, dirName, ...(workspacePath ? { workspacePath } : {}) },
        }))
      } catch {
        return [] // a corrupt or half-written dir must not sink the whole list
      }
    }),
  )
  return grouped.flat().sort((left, right) => byRecency(left.summary, right.summary))
}

/**
 * Sessions any needle matches: title hits above content hits, more needles above fewer, recency
 * within. A content hit carries a snippet around the first needle found in the first message
 * holding one. No needles at all lists every session.
 */
function matchSessions<T extends SessionSummary>(
  sessions: readonly { summary: T; texts?: string[] }[],
  query: string,
  words = false,
): (T & { snippet?: string })[] {
  const needles = searchNeedles(query, words)
  if (!needles.length) return sessions.map((session) => session.summary)
  const hits: { summary: T; snippet?: string; title: boolean; count: number }[] = []
  for (const { summary, texts = [] } of sessions) {
    const found = needles.filter(
      (needle) => needle.test(summary.title) || texts.some((text) => needle.test(text)),
    )
    if (!found.length) continue
    const title = found.some((needle) => needle.test(summary.title))
    let snippet: string | undefined
    for (const text of title ? [] : texts) {
      const indices = found.map((needle) => text.search(needle)).filter((index) => index >= 0)
      if (!indices.length) continue
      const index = Math.min(...indices)
      const from = Math.max(0, index - 40)
      const to = Math.min(text.length, index + 120)
      snippet = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`
      break
    }
    hits.push({ summary, snippet, title, count: found.length })
  }
  return hits
    .sort((left, right) => Number(right.title) - Number(left.title) || right.count - left.count)
    .map(({ summary, snippet }) => (snippet === undefined ? summary : { ...summary, snippet }))
}

function byRecency(left: SessionSummary, right: SessionSummary) {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.mtimeMs - left.mtimeMs
}

/** Omits empty detail lists so persisted turns stay compact. */
function presentTurnDetails(details: SessionTurnDetails): SessionTurnDetails {
  return {
    ...(details.toolActivities?.length ? { toolActivities: details.toolActivities } : {}),
    ...(details.subagents?.length ? { subagents: details.subagents } : {}),
  }
}
