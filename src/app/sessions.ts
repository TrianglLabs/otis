import type { InferenceClient } from "../inference/client.js"
import { createSession, deleteSession, type JsonlSession, listSessions, openSession } from "../storage/index.js"
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
  #sessionTask: Promise<JsonlSession> | undefined
  #title: string | undefined
  addedLines = 0
  removedLines = 0

  constructor(private readonly options: SessionCoordinatorOptions) {}

  get current() {
    return this.#session
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
    const task = this.#sessionTask ?? createSession({ cwd: this.options.cwd })
    this.#sessionTask = task
    try {
      this.#session = await task
      return this.#session
    } finally {
      if (this.#sessionTask === task) this.#sessionTask = undefined
    }
  }

  async select(sessionId: string): Promise<"noop" | "loaded"> {
    if (this.options.isBusy() || sessionId === this.#session?.id) return "noop"
    this.#session = await openSession({ cwd: this.options.cwd, sessionId })
    this.#loadCurrent()
    return "loaded"
  }

  async delete(sessionId: string): Promise<"deleted" | "busy"> {
    if (this.options.isBusy()) return "busy"
    await deleteSession({ cwd: this.options.cwd, sessionId })
    if (this.#session?.id === sessionId) this.reset()
    return "deleted"
  }

  startNew() {
    if (this.options.isBusy()) return false
    this.reset()
    return true
  }

  async listPickerItems(): Promise<SessionPickerItem[]> {
    const summaries = await listSessions({ cwd: this.options.cwd })
    return summaries.map((summary) => toSessionPickerItem(summary, this.#session?.id))
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
    const title = await generateSessionTitle(this.options.transcript.history, {
      client,
      onUsage: async (usage) => {
        await turnSession.recordUsage(usage, "title")
      },
    })
    if (!title || this.options.isExiting() || this.#session?.id !== turnSession.id) return undefined
    await turnSession.renameTitle(title)
    if (this.options.isExiting() || this.#session?.id !== turnSession.id) return undefined
    this.#title = title
    return title
  }

  reset() {
    this.#sessionTask = undefined
    this.#session = undefined
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
    this.options.transcript.replaceMessages(replay.messages, replay.toolActivities)
    this.options.subagents.load(replay.subagents)
    const diff = countTranscriptDiffLines(this.options.transcript.entries)
    this.addedLines = diff.added
    this.removedLines = diff.removed
  }
}
