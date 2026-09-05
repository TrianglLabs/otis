import { type AgentEvent, type RunAgentOptions, runAgent } from "../core/agent.js"
import type { CompactionResult } from "../core/compaction.js"
import type { ChatMessage, UserChatMessage } from "../inference/types.js"
import { forToolCalls, type SessionTurnDetails } from "../storage/index.js"
import { TurnDetailsRecorder } from "./turn-details.js"

export type TurnResult =
  | { status: "complete" | "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; message: string; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete"; details: SessionTurnDetails }

export type TurnRunnerOptions = {
  input: UserChatMessage
  history?: ChatMessage[]
  agent: Omit<RunAgentOptions, "onCompaction">
  historyDetails?: SessionTurnDetails
  onCompaction?: (result: CompactionResult, details: SessionTurnDetails, steeringCount: number) => void | Promise<void>
  onEvent?: (event: AgentEvent) => void | Promise<void>
}

/** Runs one agent turn without making assumptions about UI, persistence, or output format. */
export async function executeTurn(options: TurnRunnerOptions): Promise<TurnResult> {
  let recorder = new TurnDetailsRecorder()
  let historyDetails = options.historyDetails
  const details = (): SessionTurnDetails => ({
    toolActivities: recorder.toolActivities,
    subagents: recorder.subagents,
  })

  const agent: RunAgentOptions = {
    ...options.agent,
    onCompaction: async (result, steeringCount) => {
      const retained = {
        toolActivities: forToolCalls(
          [...(historyDetails?.toolActivities ?? []), ...recorder.toolActivities],
          result.keptMessages,
        ),
        subagents: forToolCalls([...(historyDetails?.subagents ?? []), ...recorder.subagents], result.keptMessages),
      }
      await options.onCompaction?.(result, retained, steeringCount)
      historyDetails = retained
      recorder = new TurnDetailsRecorder()
    },
  }
  for await (const event of runAgent(options.input, options.history ?? [], agent)) {
    recorder.record(event)

    const observation = options.onEvent?.(event)
    if (observation) await observation

    if (event.type === "complete") return { status: "complete", messages: event.messages, details: details() }
    if (event.type === "interrupted") return { status: "interrupted", messages: event.messages, details: details() }
    if (event.type === "error") {
      return { status: "error", message: event.message, messages: event.messages ?? [], details: details() }
    }
  }

  return { status: "incomplete", details: details() }
}
