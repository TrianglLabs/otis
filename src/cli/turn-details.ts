import type { AgentEvent } from "../core/agent.js"
import type { SessionSubagentRun, SessionSubagentStatus, SessionToolActivity } from "../storage/index.js"

type SubagentRecording = {
  toolCallId: string
  title: string
  startedAt: number
  status?: SessionSubagentStatus
  durationMs?: number
  messages: SessionSubagentRun["messages"]
  tools: ToolActivityRecorder
}

/** Collects the persisted tool cards of one agent run from its event stream. */
export class ToolActivityRecorder {
  readonly activities: SessionToolActivity[] = []
  readonly #indexes = new Map<string, number>()

  record(event: AgentEvent) {
    if (event.type !== "tool") return
    if (event.phase === "start") {
      this.#indexes.set(event.toolCallId, this.activities.length)
      this.activities.push({ toolCallId: event.toolCallId, activityKind: event.activityKind, label: event.label })
    }
    if (event.phase === "end" && event.diff) {
      const index = this.#indexes.get(event.toolCallId)
      if (index !== undefined) this.activities[index] = { ...this.activities[index], diff: event.diff }
    }
  }
}

/** Collects a turn's tool cards and the full trace of every delegated run for persistence. */
export class TurnDetailsRecorder {
  readonly #tools = new ToolActivityRecorder()
  readonly #subagents = new Map<string, SubagentRecording>()

  record(event: AgentEvent) {
    this.#tools.record(event)
    if (event.type === "subagent") this.recordSubagent(event)
  }

  get toolActivities() {
    return this.#tools.activities
  }

  /** Runs that ended without reporting are persisted as failed so a stored trace is never left open. */
  get subagents(): SessionSubagentRun[] {
    return [...this.#subagents.values()].map((run) => ({
      toolCallId: run.toolCallId,
      title: run.title,
      status: run.status ?? "failed",
      messages: run.messages,
      ...(run.tools.activities.length > 0 ? { toolActivities: run.tools.activities } : {}),
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    }))
  }

  private recordSubagent(envelope: Extract<AgentEvent, { type: "subagent" }>) {
    let run = this.#subagents.get(envelope.toolCallId)
    if (!run) {
      run = {
        toolCallId: envelope.toolCallId,
        title: envelope.title,
        startedAt: Date.now(),
        messages: [],
        tools: new ToolActivityRecorder(),
      }
      this.#subagents.set(envelope.toolCallId, run)
    }
    const event = envelope.event
    run.tools.record(event)
    if (event.type === "complete" || event.type === "interrupted" || event.type === "error") {
      run.status = event.type === "complete" ? "complete" : event.type === "interrupted" ? "interrupted" : "failed"
      run.messages = event.messages ?? []
      run.durationMs = Date.now() - run.startedAt
    }
  }
}
