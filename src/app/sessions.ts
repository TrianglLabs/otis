import { basename, resolve } from "node:path"
import { isCompactionSummary } from "../core/compaction.js"
import type { InferenceClient } from "../inference/client.js"
import { summarizeUserMessage, userMessageText } from "../inference/messages.js"
import type { ChatMessage } from "../inference/types.js"
import {
  acquireSessionLock,
  createSession,
  defaultSessionDirectory,
  deleteSession,
  type JsonlSession,
  listSessions,
  openSession,
  type SessionLock,
  type SessionSummary,
  type SessionToolActivity,
  searchSessions,
} from "../storage/index.js"
import type { SubagentTraces } from "./subagents.js"
import { countDiffLines, type TranscriptStore } from "./transcript.js"

const GENERATED_TITLE_MAX_LENGTH = 60
const DISPLAY_TITLE_MAX_LENGTH = 36

type SessionCoordinatorOptions = {
  client: () => InferenceClient | undefined
  cwd: string
  transcript: TranscriptStore
  subagents: SubagentTraces
  isBusy: () => boolean
  isExiting: () => boolean
  onReset?: () => void
  onReplay?: (
    messages: readonly ChatMessage[],
    activities: readonly SessionToolActivity[],
    session: JsonlSession,
  ) => void
}

export class SessionCoordinator {
  #session: JsonlSession | undefined
  /** The active session's storage directory; undefined means the workspace-derived default. */
  #directory: string | undefined
  #lock: SessionLock | undefined
  #sessionTask: Promise<JsonlSession> | undefined
  #title: string | undefined
  #added = 0
  #removed = 0

  constructor(private readonly options: SessionCoordinatorOptions) {}

  get current() {
    return this.#session
  }

  /** The active session's storage dir name — session identity is (dir, id), never id alone. */
  get currentDirName(): string | undefined {
    if (!this.#session) return undefined
    return basename(this.#directory ?? defaultSessionDirectory(this.options.cwd))
  }

  /**
   * Whether (sessionId, directory) is the active session — ids repeat across storage dirs
   * ("default").
   */
  #isCurrent(sessionId: string, directory?: string): boolean {
    if (this.#session?.id !== sessionId) return false
    const active = this.#directory ?? defaultSessionDirectory(this.options.cwd)
    return active === resolve(directory ?? defaultSessionDirectory(this.options.cwd))
  }

  get title() {
    return this.#title
  }

  get diffs() {
    return { added: this.#added, removed: this.#removed }
  }

  get transcript() {
    return this.options.transcript
  }

  get subagents() {
    return this.options.subagents
  }

  async ensure() {
    if (this.#session) return this.#session
    // Session creation plus its write lock, as one shared task — overlapping ensure() calls must
    // not self-conflict.
    const task =
      this.#sessionTask ??
      (async () => {
        const session = await createSession({ cwd: this.options.cwd })
        // A fresh id cannot be held elsewhere; failure here would mean a corrupted store, not
        // contention.
        this.#lock = await acquireSessionLock({ cwd: this.options.cwd, sessionId: session.id })
        return session
      })()
    this.#sessionTask = task
    try {
      this.#session = await task
      return this.#session
    } finally {
      if (this.#sessionTask === task) this.#sessionTask = undefined
    }
  }

  /** Releases the write lock on the active session (app shutdown, switch-away). */
  async releaseLock() {
    const lock = this.#lock
    this.#lock = undefined
    await lock?.release()
  }

  /**
   * Reacquires the active session's write lock after a read-only preview — the locate flow's
   * completion. History is reloaded under the lock: another instance may have written while we
   * were unlocked, and appending onto stale in-memory state would duplicate event sequences.
   */
  async relock(): Promise<"ok" | "locked"> {
    if (!this.#session || this.#lock) return "ok"
    const sessionId = this.#session.id
    const where = {
      cwd: this.options.cwd,
      ...(this.#directory ? { directory: this.#directory } : {}),
    }
    let lock: SessionLock
    try {
      lock = await acquireSessionLock({ ...where, sessionId })
    } catch {
      return "locked"
    }
    let session: JsonlSession
    try {
      session = await openSession({ ...where, sessionId })
    } catch (error) {
      await lock.release()
      throw error
    }
    this.#session = session
    this.#lock = lock
    this.#loadCurrent(session)
    return "ok"
  }

  async select(
    sessionId: string,
    storage?: { directory: string },
  ): Promise<"noop" | "loaded" | "locked"> {
    if (this.options.isBusy() || this.#isCurrent(sessionId, storage?.directory)) return "noop"
    // A directory override opens the session by its storage identity (locate-workspace flow); the
    // cwd-derived default would silently resolve to a different conversation when folder and
    // history disagree.
    const where = { cwd: this.options.cwd, ...storage }
    let lock: SessionLock
    try {
      lock = await acquireSessionLock({ ...where, sessionId })
    } catch {
      return "locked" // open in another Otis process — writes must not interleave
    }
    const session = await openSession({ ...where, sessionId })
    this.#session = session
    this.#directory = storage?.directory ? resolve(storage.directory) : undefined
    await this.releaseLock()
    this.#lock = lock
    this.#loadCurrent(session)
    return "loaded"
  }

  async delete(
    sessionId: string,
    storage?: { directory: string },
  ): Promise<"deleted" | "busy" | "locked"> {
    if (this.options.isBusy()) return "busy"
    // Same storage identity as select: a located session must not delete the workspace-store file
    // of the same id.
    const where = { cwd: this.options.cwd, ...storage }
    const deletingCurrent = this.#isCurrent(sessionId, storage?.directory)
    let guard: SessionLock | undefined
    // The current session skips the guard only while we provably hold its write lock. A read-only
    // preview (pending workspace locate) releases it, and another instance may own the session by
    // the time we delete.
    if (!deletingCurrent || this.#lock === undefined) {
      // A session another instance is writing to is not ours to delete: removing the file would
      // orphan the owner's lock and its next turn would recreate a truncated history.
      try {
        guard = await acquireSessionLock({ ...where, sessionId })
      } catch {
        return "locked"
      }
    }
    try {
      // The guard stays held through the removal — releasing first would let another writer in
      // between.
      await deleteSession({ ...where, sessionId })
    } finally {
      await guard?.release()
    }
    if (deletingCurrent) {
      void this.releaseLock()
      this.reset()
    }
    return "deleted"
  }

  startNew() {
    if (this.options.isBusy()) return false
    void this.releaseLock()
    this.reset()
    return true
  }

  async listPickerItems(): Promise<SessionPickerItem[]> {
    const summaries = await listSessions({ cwd: this.options.cwd })
    return summaries.map((summary) => toSessionPickerItem(summary, this.#session?.id))
  }

  /** Title-first session search for the desktop command palette; content hits carry a snippet. */
  async searchPickerItems(query: string): Promise<SessionPickerItem[]> {
    const results = await searchSessions({ cwd: this.options.cwd }, query)
    return results.map((result) => ({
      ...toSessionPickerItem(result, this.#session?.id),
      snippet: result.snippet,
    }))
  }

  provisionalLabel(input: string) {
    return formatSessionLabel(input)
  }

  activeLabel() {
    if (this.#title) return this.#title
    const first = this.options.transcript.history.find(
      (message) => message.role === "user" && !isCompactionSummary(message),
    )
    return first?.role === "user"
      ? formatSessionLabel(userMessageText(first) || summarizeUserMessage(first))
      : "Current session"
  }

  addDiff(added: number, removed: number) {
    this.#added += added
    this.#removed += removed
    return this.diffs
  }

  async generateTitle(turnSession: JsonlSession): Promise<string | undefined> {
    const client = this.options.client()
    const messages = this.options.transcript.history
    if (
      !client ||
      !messages.some((message) => message.role === "user" && !isCompactionSummary(message))
    ) {
      return undefined
    }
    const lines: string[] = []
    for (const message of messages.slice(0, 6)) {
      if (message.role === "user" && !isCompactionSummary(message)) {
        lines.push(`User: ${summarizeUserMessage(message).slice(0, 500)}`)
        continue
      }
      if (message.role !== "assistant") continue
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .slice(0, 500)
      if (text) lines.push(`Assistant: ${text}`)
    }
    const prompt = `Summarize this conversation in 3-6 words as a concise title. Output only the title, no quotes, no punctuation.

Conversation:
${lines.join("\n")}`
    let title: string
    try {
      const raw = await client.complete([{ role: "user", content: prompt }], {
        onUsage: async (usage) => {
          await turnSession.recordUsage(usage, "title")
        },
      })
      const cleaned = raw
        .replace(/["“”']/g, "")
        .trim()
        .split("\n")[0]
        ?.trim()
      if (!cleaned) return undefined
      title =
        cleaned.length > GENERATED_TITLE_MAX_LENGTH
          ? `${cleaned.slice(0, GENERATED_TITLE_MAX_LENGTH - 1)}…`
          : cleaned
    } catch {
      // Title generation is best-effort: an inference failure must not take down the caller's
      // turn completion path.
      return undefined
    }
    if (this.options.isExiting() || this.#session?.id !== turnSession.id) return undefined
    await turnSession.renameTitle(title)
    if (this.options.isExiting() || this.#session?.id !== turnSession.id) return undefined
    this.#title = title
    return title
  }

  reset() {
    this.#sessionTask = undefined
    this.#session = undefined
    this.#directory = undefined
    this.#title = undefined
    this.#added = 0
    this.#removed = 0
    this.options.transcript.replaceMessages([])
    this.options.subagents.load([])
    this.options.onReset?.()
  }

  #loadCurrent(session: JsonlSession) {
    this.#title = session.hasTitle() ? session.title() : undefined
    const transcript = session.replayTranscript()
    this.options.transcript.replaceMessages(session.replay().messages, transcript.turns)
    this.options.subagents.load(transcript.subagents)
    this.options.onReplay?.(transcript.messages, transcript.toolActivities, session)
    this.#added = 0
    this.#removed = 0
    for (const entry of this.options.transcript.entries) {
      if (!entry.diff) continue
      const counts = countDiffLines(entry.diff)
      this.#added += counts.added
      this.#removed += counts.removed
    }
  }
}

function formatSessionLabel(text: string) {
  const line = text.trim().split("\n")[0]?.trim() || "Current session"
  if (line.length <= DISPLAY_TITLE_MAX_LENGTH) return line
  const left = Math.ceil((DISPLAY_TITLE_MAX_LENGTH - 1) / 2)
  const right = Math.floor((DISPLAY_TITLE_MAX_LENGTH - 1) / 2)
  return `${line.slice(0, left)}…${line.slice(line.length - right)}`
}

export type SessionPickerItem = {
  id: string
  title: string
  detail: string
  active?: boolean
  /** First content match context; set only by search, when the match is not in the title. */
  snippet?: string
}

export function toSessionPickerItem(
  summary: SessionSummary,
  activeSessionId?: string,
): SessionPickerItem {
  return {
    id: summary.id,
    title: summary.title,
    detail: formatSessionAge(summary.updatedAt),
    active: summary.id === activeSessionId,
  }
}

function formatSessionAge(value: string) {
  const updatedAt = Date.parse(value)
  if (!Number.isFinite(updatedAt)) return "unknown"
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
