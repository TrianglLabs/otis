import { basename, resolve } from "node:path"
import type { InferenceClient } from "../inference/client.js"
import {
  acquireSessionLock,
  createSession,
  defaultSessionDirectory,
  deleteSession,
  type JsonlSession,
  listSessions,
  openSession,
  type SessionLock,
  searchSessions,
} from "../storage/index.js"
import { countTranscriptDiffLines, type DiffStats } from "./diff-stats.js"
import {
  activeSessionLabel,
  formatSessionLabel,
  generateSessionTitle,
  type SessionPickerItem,
  toSessionPickerItem,
} from "./session-metadata.js"
import type { SubagentTraces } from "./subagents.js"
import type { TranscriptStore } from "./transcript.js"

export type SessionCoordinatorOptions = {
  client: () => InferenceClient | undefined
  cwd: string
  transcript: TranscriptStore
  subagents: SubagentTraces
  isBusy: () => boolean
  isExiting: () => boolean
}

export class SessionCoordinator {
  #session: JsonlSession | undefined
  /** The active session's storage directory; undefined means the workspace-derived default. */
  #directory: string | undefined
  #lock: SessionLock | undefined
  #sessionTask: Promise<JsonlSession> | undefined
  #title: string | undefined
  addedLines = 0
  removedLines = 0

  constructor(private readonly options: SessionCoordinatorOptions) {}

  get current() {
    return this.#session
  }

  /** The active session's storage dir name — session identity is (dir, id), never id alone. */
  get currentDirName(): string | undefined {
    if (!this.#session) return undefined
    return basename(this.#directory ?? defaultSessionDirectory(this.options.cwd))
  }

  /** Whether (sessionId, directory) is the active session — ids repeat across storage dirs ("default"). */
  #isCurrent(sessionId: string, directory?: string): boolean {
    if (this.#session?.id !== sessionId) return false
    const active = this.#directory ?? defaultSessionDirectory(this.options.cwd)
    return active === resolve(directory ?? defaultSessionDirectory(this.options.cwd))
  }

  get title() {
    return this.#title
  }

  get diffs(): DiffStats {
    return { added: this.addedLines, removed: this.removedLines }
  }

  get transcript() {
    return this.options.transcript
  }

  get subagents() {
    return this.options.subagents
  }

  async ensure() {
    if (this.#session) return this.#session
    const task = this.#sessionTask ?? this.#createLocked()
    this.#sessionTask = task
    try {
      this.#session = await task
      return this.#session
    } finally {
      if (this.#sessionTask === task) this.#sessionTask = undefined
    }
  }

  /** Session creation plus its write lock, as one shared task — overlapping ensure() calls must not self-conflict. */
  async #createLocked(): Promise<JsonlSession> {
    const session = await createSession({ cwd: this.options.cwd })
    // A fresh id cannot be held elsewhere; failure here would mean a corrupted store, not contention.
    this.#lock = await acquireSessionLock({ cwd: this.options.cwd, sessionId: session.id })
    return session
  }

  /** Releases the write lock on the active session (app shutdown, switch-away). */
  async releaseLock() {
    const lock = this.#lock
    this.#lock = undefined
    await lock?.release()
  }

  /**
   * Reacquires the active session's write lock after a read-only preview — the locate flow's completion.
   * History is reloaded under the lock: another instance may have written while we were unlocked, and
   * appending onto stale in-memory state would duplicate event sequences.
   */
  async relock(): Promise<"ok" | "locked"> {
    if (!this.#session || this.#lock) return "ok"
    const sessionId = this.#session.id
    const where = { cwd: this.options.cwd, ...(this.#directory ? { directory: this.#directory } : {}) }
    let lock: SessionLock
    try {
      lock = await acquireSessionLock({ ...where, sessionId })
    } catch {
      return "locked"
    }
    try {
      this.#session = await openSession({ ...where, sessionId })
    } catch (error) {
      await lock.release()
      throw error
    }
    this.#lock = lock
    this.#loadCurrent()
    return "ok"
  }

  async select(sessionId: string, storage?: { directory: string }): Promise<"noop" | "loaded" | "locked"> {
    if (this.options.isBusy() || this.#isCurrent(sessionId, storage?.directory)) return "noop"
    // A directory override opens the session by its storage identity (locate-workspace flow); the cwd-derived
    // default would silently resolve to a different conversation when folder and history disagree.
    const where = { cwd: this.options.cwd, ...storage }
    let lock: SessionLock
    try {
      lock = await acquireSessionLock({ ...where, sessionId })
    } catch {
      return "locked" // open in another Otis process — writes must not interleave
    }
    this.#session = await openSession({ ...where, sessionId })
    this.#directory = storage?.directory ? resolve(storage.directory) : undefined
    await this.releaseLock()
    this.#lock = lock
    this.#loadCurrent()
    return "loaded"
  }

  async delete(sessionId: string, storage?: { directory: string }): Promise<"deleted" | "busy" | "locked"> {
    if (this.options.isBusy()) return "busy"
    // Same storage identity as select: a located session must not delete the workspace-store file of the same id.
    const where = { cwd: this.options.cwd, ...storage }
    const deletingCurrent = this.#isCurrent(sessionId, storage?.directory)
    let guard: SessionLock | undefined
    // The current session skips the guard only while we provably hold its write lock. A read-only preview
    // (pending workspace locate) releases it, and another instance may own the session by the time we delete.
    if (!deletingCurrent || this.#lock === undefined) {
      // A session another instance is writing to is not ours to delete: removing the file would orphan the
      // owner's lock and its next turn would recreate a truncated history.
      try {
        guard = await acquireSessionLock({ ...where, sessionId })
      } catch {
        return "locked"
      }
    }
    try {
      // The guard stays held through the removal — releasing first would let another writer in between.
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
    return results.map((result) => ({ ...toSessionPickerItem(result, this.#session?.id), snippet: result.snippet }))
  }

  provisionalLabel(input: string) {
    return formatSessionLabel(input)
  }

  activeLabel() {
    return activeSessionLabel(this.options.transcript.history, this.#title)
  }

  addDiff(added: number, removed: number): DiffStats {
    this.addedLines += added
    this.removedLines += removed
    return this.diffs
  }

  async generateTitle(turnSession: JsonlSession): Promise<string | undefined> {
    const client = this.options.client()
    if (!client) return undefined
    // Title generation is best-effort: an inference failure must not take down the caller's turn completion path.
    const title = await generateSessionTitle(this.options.transcript.history, {
      client,
      onUsage: async (usage) => {
        await turnSession.recordUsage(usage, "title")
      },
    }).catch(() => undefined)
    if (!title || this.options.isExiting() || this.#session?.id !== turnSession.id) return undefined
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
    this.addedLines = 0
    this.removedLines = 0
    this.options.transcript.replaceMessages([])
    this.options.subagents.load([])
  }

  #loadCurrent() {
    if (!this.#session) return
    this.#title = this.#session.hasTitle() ? this.#session.title() : undefined
    const replay = this.#session.replay()
    const transcript = this.#session.replayTranscript()
    this.options.transcript.replaceMessages(replay.messages, transcript.toolActivities, transcript.messages)
    this.options.subagents.load(transcript.subagents)
    const diff = countTranscriptDiffLines(this.options.transcript.entries)
    this.addedLines = diff.added
    this.removedLines = diff.removed
  }
}
