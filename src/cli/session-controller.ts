import type { SessionCoordinator } from "../app/sessions.js"
import type { JsonlSession } from "../storage/index.js"
import type { ChatUI } from "./ui/types.js"

type SessionControllerOptions = {
  sessions: SessionCoordinator
  ui: ChatUI
  onTranscriptChange: () => void
}

export class SessionController {
  constructor(private readonly options: SessionControllerOptions) {}

  async openPicker() {
    try {
      this.options.ui.showSessionPicker(await this.options.sessions.listPickerItems())
    } catch (error) {
      this.reportError("Could not load sessions", error)
    }
  }

  async select(sessionId: string) {
    try {
      const result = await this.options.sessions.select(sessionId)
      if (result === "noop") {
        this.options.ui.focusInput()
        return
      }
      this.reflectSession()
    } catch (error) {
      this.reportError("Could not open session", error)
    }
  }

  async delete(sessionId: string) {
    const wasCurrent = this.options.sessions.current?.id === sessionId
    try {
      const result = await this.options.sessions.delete(sessionId)
      if (result === "busy") {
        await this.refreshPickerIfPossible()
        return
      }
      if (wasCurrent) this.reflectSession()
      await this.refreshPickerIfPossible()
    } catch (error) {
      this.reportError("Could not delete session", error)
      await this.refreshPickerIfPossible()
    }
  }

  startNew() {
    if (!this.options.sessions.startNew()) return
    this.options.ui.hideSessionPicker()
    this.reflectSession()
    this.options.ui.focusInput()
  }

  setProvisionalLabel(input: string) {
    this.options.ui.setSessionLabel(this.options.sessions.provisionalLabel(input))
  }

  refreshLabel() {
    this.options.ui.setSessionLabel(this.options.sessions.activeLabel())
  }

  addDiff(added: number, removed: number) {
    const diffs = this.options.sessions.addDiff(added, removed)
    this.options.ui.setDiffStats(diffs.added, diffs.removed)
  }

  async generateTitle(turnSession: JsonlSession) {
    try {
      const title = await this.options.sessions.generateTitle(turnSession)
      if (title) this.options.ui.setSessionLabel(title)
    } catch {
      // Title generation is best-effort; the first user message remains as the label.
    }
  }

  private async refreshPickerIfPossible() {
    try {
      this.options.ui.showSessionPicker(await this.options.sessions.listPickerItems())
    } catch {
      // Keep the current picker state if disk re-sync fails after the primary action.
    }
  }

  private reflectSession() {
    const { sessions, ui } = this.options
    const diffs = sessions.diffs
    ui.setDiffStats(diffs.added, diffs.removed)
    this.refreshLabel()
    ui.showChatLayout()
    ui.renderTranscript(sessions.transcript.entries, { scrollToBottom: true })
    ui.renderSubagents(sessions.subagents.all)
    this.options.onTranscriptChange()
    ui.focusInput()
  }

  private reportError(prefix: string, error: unknown) {
    const { sessions, ui } = this.options
    ui.showChatLayout()
    sessions.transcript.addAssistantMessage(
      `Error: ${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    )
    ui.renderTranscript(sessions.transcript.entries, { scrollToBottom: true })
    ui.focusInput()
  }
}
