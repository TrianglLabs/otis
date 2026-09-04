import { type AgentEvent, type RunAgentOptions, runAgent } from "../core/agent.js"
import type { ChatMessage, UserChatMessage } from "../inference/types.js"
import type { SessionTurnDetails } from "../storage/index.js"
import { TurnDetailsRecorder } from "./turn-details.js"

export type TurnResult =
  | { status: "complete" | "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; message: string; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete"; details: SessionTurnDetails }

export type TurnRunnerOptions = {
  input: UserChatMessage
  history?: ChatMessage[]
  agent: RunAgentOptions
  onEvent?: (event: AgentEvent) => void | Promise<void>
}

/** Runs one agent turn without making assumptions about UI, persistence, or output format. */
export async function executeTurn(options: TurnRunnerOptions): Promise<TurnResult> {
  const recorder = new TurnDetailsRecorder()
  const details = (): SessionTurnDetails => ({
    toolActivities: recorder.toolActivities,
    subagents: recorder.subagents,
  })

  for await (const event of runAgent(options.input, options.history ?? [], options.agent)) {
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
