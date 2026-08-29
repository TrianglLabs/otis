import type { InferenceClient } from "../inference/client.js"
import { createSession, deleteSession, type JsonlSession, listSessions, openSession } from "../storage/index.js"
import { countTranscriptDiffLines } from "./diff-stats.js"
import {
  activeSessionLabel,
  formatSessionLabel,
  generateSessionTitle,
  toSessionPickerItem,
} from "./session-metadata.js"
import type { TranscriptStore } from "./transcript.js"
import type { ChatUI } from "./ui/types.js"

type SessionControllerOptions = {
  client: () => InferenceClient | undefined
  cwd: string
  transcript: TranscriptStore
  ui: ChatUI
  isBusy: () => boolean
  isExiting: () => boolean
  onTranscriptChange: () => void
}

export class SessionController {
  private session: JsonlSession | undefined
  private sessionTask: Promise<JsonlSession> | undefined
  private title: string | undefined
  private addedLines = 0
  private removedLines = 0

  constructor(private readonly options: SessionControllerOptions) {}

  async openPicker() {
    try {
      await this.refreshPicker()
    } catch (error) {
      this.reportError("Could not load sessions", error)
    }
  }

  async select(sessionId: string) {
    if (this.options.isBusy() || sessionId === this.session?.id) {
      this.options.ui.focusInput()
      return
    }

    try {
      this.session = await openSession({ cwd: this.options.cwd, sessionId })
      this.loadCurrent()
    } catch (error) {
      this.reportError("Could not open session", error)
    }
  }

  async delete(sessionId: string) {
    if (this.options.isBusy()) {
      await this.refreshPickerIfPossible()
      return
    }

    try {
      await deleteSession({ cwd: this.options.cwd, sessionId })
    } catch (error) {
      this.reportError("Could not delete session", error)
      await this.refreshPickerIfPossible()
      return
    }

    if (this.session?.id === sessionId) this.resetCurrent()
    await this.refreshPickerIfPossible()
  }

  startNew() {
    if (this.options.isBusy()) return
    this.options.ui.hideSessionPicker()
    this.resetCurrent()
    this.options.ui.focusInput()
  }

  async ensure() {
    if (this.session) return this.session
    const task = this.sessionTask ?? createSession({ cwd: this.options.cwd })
    this.sessionTask = task
    try {
      this.session = await task
      return this.session
    } finally {
      if (this.sessionTask === task) this.sessionTask = undefined
    }
  }

  setProvisionalLabel(input: string) {
    this.options.ui.setSessionLabel(formatSessionLabel(input))
  }

  refreshLabel() {
    this.options.ui.setSessionLabel(activeSessionLabel(this.options.transcript.history, this.title))
  }

  addDiff(added: number, removed: number) {
    this.addedLines += added
    this.removedLines += removed
    this.options.ui.setDiffStats(this.addedLines, this.removedLines)
  }

  async generateTitle(turnSession: JsonlSession) {
    try {
      const client = this.options.client()
      if (!client) return
      const title = await generateSessionTitle(this.options.transcript.history, {
        client,
        onUsage: async (usage) => {
          await turnSession.recordUsage(usage, "title")
        },
      })
      if (!title || this.options.isExiting() || this.session?.id !== turnSession.id) return
      await turnSession.renameTitle(title)
      if (this.options.isExiting() || this.session?.id !== turnSession.id) return
      this.title = title
      this.options.ui.setSessionLabel(title)
    } catch {
      // Title generation is best-effort; the first user message remains as the label.
    }
  }

  private async refreshPicker() {
    const summaries = await listSessions({ cwd: this.options.cwd })
    this.options.ui.showSessionPicker(summaries.map((summary) => toSessionPickerItem(summary, this.session?.id)))
  }

  private async refreshPickerIfPossible() {
    try {
      await this.refreshPicker()
    } catch {
      // Keep the current picker state if disk re-sync fails after the primary action.
    }
  }

  private loadCurrent() {
    if (!this.session) return
    this.title = this.session.hasTitle() ? this.session.title() : undefined
    const replay = this.session.replay()
    this.options.transcript.replaceMessages(replay.messages, replay.toolActivities)
    const diff = countTranscriptDiffLines(this.options.transcript.entries)
    this.addedLines = diff.added
    this.removedLines = diff.removed
    this.options.ui.setDiffStats(diff.added, diff.removed)
    this.refreshLabel()
    this.options.ui.showChatLayout()
    this.options.ui.renderTranscript(this.options.transcript.entries, { scrollToBottom: true })
    this.options.onTranscriptChange()
    this.options.ui.focusInput()
  }

  private resetCurrent() {
    this.sessionTask = undefined
    this.session = undefined
    this.title = undefined
    this.addedLines = 0
    this.removedLines = 0
    this.options.transcript.replaceMessages([])
    this.options.ui.setDiffStats(0, 0)
    this.refreshLabel()
    this.options.ui.renderTranscript(this.options.transcript.entries, { scrollToBottom: true })
    this.options.onTranscriptChange()
  }

  private reportError(prefix: string, error: unknown) {
    this.options.ui.showChatLayout()
    this.options.transcript.addAssistantMessage(
      `Error: ${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    )
    this.options.ui.renderTranscript(this.options.transcript.entries, { scrollToBottom: true })
    this.options.ui.focusInput()
  }
}
