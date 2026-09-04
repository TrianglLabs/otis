import type { AgentEvent } from "../core/agent.js"
import type { TranscriptEntry, TranscriptStore } from "./transcript.js"

/**
 * Projects one agent run's event stream onto a transcript as streamed assistant text, reasoning cards, tool cards,
 * and debug lines. The main conversation and every delegated run's trace use the same projection.
 */
export class TranscriptProjector {
  #assistantText = ""
  #assistantEntry: TranscriptEntry | undefined
  readonly #reasoning = new Map<string, { entryId: number; text: string }>()
  readonly #tools = new Map<string, number>()

  constructor(private readonly transcript: TranscriptStore) {}

  /** Applies the event to the transcript and reports whether any entry changed. */
  apply(event: AgentEvent): boolean {
    if (event.type === "reasoning") return this.applyReasoning(event)
    if (event.type === "delta") {
      this.#assistantText += event.text
      this.transcript.updateEntry(this.ensureAssistantEntry().id, { text: this.#assistantText, streaming: true })
      return true
    }
    if (event.type === "tool") return this.applyTool(event)
    if (event.type === "debug") {
      for (const line of event.message.split("\n")) this.transcript.addDebugMessage(line)
      return true
    }
    return false
  }

  /** The assistant message currently receiving text, created empty when the run has not produced any yet. */
  ensureAssistantEntry(): TranscriptEntry {
    this.#assistantEntry ??= this.transcript.addAssistantMessage("")
    return this.#assistantEntry
  }

  /** Marks the streaming assistant message as finished once the run ends or is interrupted. */
  finishStreaming() {
    if (this.#assistantEntry) this.transcript.updateEntry(this.#assistantEntry.id, { streaming: false })
  }

  /** Reasoning and tool activity end the current assistant message; later text starts a fresh one. */
  private closeAssistantEntry() {
    this.finishStreaming()
    this.#assistantEntry = undefined
    this.#assistantText = ""
  }

  private applyReasoning(event: Extract<AgentEvent, { type: "reasoning" }>) {
    if (event.phase === "start") {
      this.closeAssistantEntry()
      const entry = this.transcript.addReasoningMessage("", {
        reasoningId: event.reasoningId,
        startedAt: event.startedAt,
        streaming: true,
      })
      this.#reasoning.set(event.reasoningId, { entryId: entry.id, text: "" })
      return true
    }
    const reasoning = this.#reasoning.get(event.reasoningId)
    if (!reasoning) return false
    if (event.phase === "delta") {
      reasoning.text += event.text
      this.transcript.updateEntry(reasoning.entryId, { text: reasoning.text, streaming: true })
    } else {
      this.transcript.updateEntry(reasoning.entryId, {
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        streaming: false,
      })
    }
    return true
  }

  private applyTool(event: Extract<AgentEvent, { type: "tool" }>) {
    if (event.phase === "start") {
      this.closeAssistantEntry()
      const entry = this.transcript.addToolMessage(event.label, event.activityKind, { toolCallId: event.toolCallId })
      this.#tools.set(event.toolCallId, entry.id)
      return true
    }
    if (!event.diff) return false
    const entryId = this.#tools.get(event.toolCallId)
    if (entryId !== undefined) this.transcript.updateEntry(entryId, { diff: event.diff })
    return true
  }
}
