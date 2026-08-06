import { type AgentEvent, type RunAgentOptions, runAgent } from "../core/agent.js"
import type { ChatMessage, UserChatMessage } from "../inference/types.js"
import type { SessionToolActivity } from "../storage/index.js"

export type TurnResult =
  | { status: "complete" | "interrupted"; messages: ChatMessage[]; toolActivities: SessionToolActivity[] }
  | { status: "error"; message: string; messages: ChatMessage[]; toolActivities: SessionToolActivity[] }
  | { status: "incomplete"; toolActivities: SessionToolActivity[] }

export type TurnRunnerOptions = {
  input: UserChatMessage
  history?: ChatMessage[]
  agent: RunAgentOptions
  onEvent?: (event: AgentEvent) => void | Promise<void>
}

/** Runs one agent turn without making assumptions about UI, persistence, or output format. */
export async function executeTurn(options: TurnRunnerOptions): Promise<TurnResult> {
  const toolActivities: SessionToolActivity[] = []
  const activityIndexes = new Map<string, number>()

  for await (const event of runAgent(options.input, options.history ?? [], options.agent)) {
    if (event.type === "tool" && event.phase === "start") {
      activityIndexes.set(event.toolCallId, toolActivities.length)
      toolActivities.push({
        toolCallId: event.toolCallId,
        activityKind: event.activityKind,
        label: event.label,
      })
    }
    if (event.type === "tool" && event.phase === "end" && event.diff) {
      const index = activityIndexes.get(event.toolCallId)
      if (index !== undefined) toolActivities[index] = { ...toolActivities[index], diff: event.diff }
    }

    const observation = options.onEvent?.(event)
    if (observation) await observation

    if (event.type === "complete") return { status: "complete", messages: event.messages, toolActivities }
    if (event.type === "interrupted") return { status: "interrupted", messages: event.messages, toolActivities }
    if (event.type === "error") {
      return { status: "error", message: event.message, messages: event.messages ?? [], toolActivities }
    }
  }

  return { status: "incomplete", toolActivities }
}
