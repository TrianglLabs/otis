import type { AgentEvent } from "../core/agent.js"
import type { ChatMessage } from "../inference/types.js"
import { forToolCalls, type SessionSubagentRun, type SessionSubagentStatus } from "../storage/index.js"
import { TranscriptStore } from "./transcript.js"
import { TranscriptProjector } from "./transcript-projector.js"

export type SubagentStatus = "running" | SessionSubagentStatus

/** One delegated run as the interface shows it: its title, progress, and a transcript of everything it did. */
export type SubagentTrace = {
  readonly toolCallId: string
  readonly title: string
  readonly status: SubagentStatus
  readonly durationMs?: number
  readonly transcript: TranscriptStore
}

type LiveTrace = {
  trace: SubagentTrace
  projector: TranscriptProjector
  startedAt: number
}

/** The delegated runs of the current session, built live from `subagent` events or loaded from a saved session. */
export class SubagentTraces {
  readonly #traces = new Map<string, LiveTrace>()

  get all(): readonly SubagentTrace[] {
    return [...this.#traces.values()].map((live) => live.trace)
  }

  get(toolCallId: string) {
    return this.#traces.get(toolCallId)?.trace
  }

  /** Applies one wrapped child event and returns the trace it belongs to. */
  apply(envelope: Extract<AgentEvent, { type: "subagent" }>): SubagentTrace {
    let live = this.#traces.get(envelope.toolCallId)
    if (!live) {
      const transcript = new TranscriptStore()
      live = {
        trace: { toolCallId: envelope.toolCallId, title: envelope.title, status: "running", transcript },
        projector: new TranscriptProjector(transcript),
        startedAt: Date.now(),
      }
      this.#traces.set(envelope.toolCallId, live)
    }

    const event = envelope.event
    live.projector.apply(event)
    if (event.type === "complete" || event.type === "interrupted" || event.type === "error") {
      live.projector.finishStreaming()
      live.trace.transcript.addMessages(event.messages ?? [])
      live.trace = {
        ...live.trace,
        status: event.type === "complete" ? "complete" : event.type === "interrupted" ? "interrupted" : "failed",
        durationMs: Date.now() - live.startedAt,
      }
    }
    return live.trace
  }

  /** Replaces every trace with the runs saved in a session. */
  load(runs: readonly SessionSubagentRun[]) {
    this.#traces.clear()
    for (const run of runs) {
      const transcript = new TranscriptStore()
      transcript.loadMessages(run.messages, run.toolActivities)
      this.#traces.set(run.toolCallId, {
        trace: {
          toolCallId: run.toolCallId,
          title: run.title,
          status: run.status,
          transcript,
          ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
        },
        projector: new TranscriptProjector(transcript),
        startedAt: 0,
      })
    }
  }

  /** The finished runs whose delegating call survives in `messages`, in the persisted shape. */
  runsFor(messages: readonly ChatMessage[]): SessionSubagentRun[] {
    const finished = this.all.flatMap((trace) =>
      trace.status === "running" ? [] : [toSessionRun(trace, trace.status)],
    )
    return forToolCalls(finished, messages)
  }
}

function toSessionRun(trace: SubagentTrace, status: SessionSubagentStatus): SessionSubagentRun {
  const toolActivities = trace.transcript.toolActivitiesFor(trace.transcript.history)
  return {
    toolCallId: trace.toolCallId,
    title: trace.title,
    status,
    messages: trace.transcript.history,
    ...(toolActivities.length > 0 ? { toolActivities } : {}),
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
  }
}
