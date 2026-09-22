import { type AgentEvent, type RunAgentOptions, runAgent } from "../core/agent.js"
import { type CompactionResult, compactionSummaryMessage } from "../core/compaction.js"
import type { ChatMessage, UserChatMessage } from "../inference/types.js"
import {
  forToolCalls,
  type SessionSubagentRun,
  type SessionSubagentStatus,
  type SessionToolActivity,
  type SessionTurnDetails,
  type SessionTurnSegment,
} from "../storage/index.js"

export type TurnResult =
  | { status: "complete" | "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; message: string; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete"; details: SessionTurnDetails }

export type TurnRunnerOptions = {
  input: UserChatMessage
  history?: ChatMessage[]
  agent: Omit<RunAgentOptions, "onCompaction">
  historyDetails?: SessionTurnDetails
  onCompaction?: (
    result: CompactionResult,
    details: SessionTurnDetails,
    steeringCount: number,
    turn: SessionTurnSegment,
  ) => void | Promise<void>
  onEvent?: (event: AgentEvent) => void | Promise<void>
}

/** Collects the persisted tool cards of one agent run from its event stream. */
class ToolActivityRecorder {
  readonly activities: SessionToolActivity[] = []
  readonly #indexes = new Map<string, number>()

  record(event: AgentEvent) {
    if (event.type !== "tool") return
    if (event.phase === "start") {
      this.#indexes.set(event.toolCallId, this.activities.length)
      this.activities.push({
        toolCallId: event.toolCallId,
        activityKind: event.activityKind,
        label: event.label,
      })
      return
    }
    const index = this.#indexes.get(event.toolCallId)
    if (index === undefined || (!event.diff && !event.artifact)) return
    this.activities[index] = {
      ...this.activities[index],
      ...(event.diff ? { diff: event.diff } : {}),
      ...(event.artifact ? { artifact: event.artifact } : {}),
    }
  }
}

type SubagentRecording = {
  toolCallId: string
  title: string
  startedAt: number
  status?: SessionSubagentStatus
  durationMs?: number
  messages: SessionSubagentRun["messages"]
  tools: ToolActivityRecorder
}

/** Collects a turn's tool cards and the full trace of every delegated run for persistence. */
class TurnDetailsRecorder {
  readonly #tools = new ToolActivityRecorder()
  readonly #subagents = new Map<string, SubagentRecording>()

  get toolActivities() {
    return this.#tools.activities
  }

  /** Runs that ended without reporting persist as failed so a stored trace is never left open. */
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

  record(event: AgentEvent) {
    this.#tools.record(event)
    if (event.type !== "subagent") return
    let run = this.#subagents.get(event.toolCallId)
    if (!run) {
      run = {
        toolCallId: event.toolCallId,
        title: event.title,
        startedAt: Date.now(),
        messages: [],
        tools: new ToolActivityRecorder(),
      }
      this.#subagents.set(event.toolCallId, run)
    }
    const child = event.event
    run.tools.record(child)
    if (child.type === "compaction" && child.phase === "complete") {
      run.messages.push(...child.messages, compactionSummaryMessage(child.summary))
    }
    if (child.type === "complete" || child.type === "interrupted" || child.type === "error") {
      run.status =
        child.type === "complete"
          ? "complete"
          : child.type === "interrupted"
            ? "interrupted"
            : "failed"
      run.messages.push(...(child.messages ?? []))
      run.durationMs = Date.now() - run.startedAt
    }
  }
}

export async function executeTurn(options: TurnRunnerOptions): Promise<TurnResult> {
  let recorder = new TurnDetailsRecorder()
  let historyDetails = options.historyDetails
  const details = (): SessionTurnDetails => ({
    toolActivities: recorder.toolActivities,
    subagents: recorder.subagents,
  })

  const agent: RunAgentOptions = {
    ...options.agent,
    onCompaction: async (result, steeringCount, messages) => {
      const retained = {
        toolActivities: forToolCalls(
          [...(historyDetails?.toolActivities ?? []), ...recorder.toolActivities],
          result.keptMessages,
        ),
        subagents: forToolCalls(
          [...(historyDetails?.subagents ?? []), ...recorder.subagents],
          result.keptMessages,
        ),
      }
      await options.onCompaction?.(result, retained, steeringCount, { messages, ...details() })
      historyDetails = retained
      recorder = new TurnDetailsRecorder()
    },
  }
  for await (const event of runAgent(options.input, options.history ?? [], agent)) {
    recorder.record(event)
    const observation = options.onEvent?.(event)
    if (observation) await observation
    if (event.type === "complete")
      return { status: "complete", messages: event.messages, details: details() }
    if (event.type === "interrupted")
      return { status: "interrupted", messages: event.messages, details: details() }
    if (event.type === "error") {
      return {
        status: "error",
        message: event.message,
        messages: event.messages ?? [],
        details: details(),
      }
    }
  }
  return { status: "incomplete", details: details() }
}
