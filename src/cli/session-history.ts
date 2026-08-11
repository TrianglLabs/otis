import { autoCompactThreshold, compactConversation, compactionSummaryMessage } from "../core/compaction.js"
import type { FireworksClient } from "../inference/client.js"
import type { ChatMessage, TokenUsage } from "../inference/types.js"
import type { JsonlSession, SessionToolActivity } from "../storage/index.js"
import { estimateContextTokens } from "./context-meter.js"

type SessionHistoryOptions = {
  session: JsonlSession
  client: FireworksClient
  contextLength?: number
  staticContextChars: number
  signal?: AbortSignal
  onUsage?: (usage: TokenUsage) => void | Promise<void>
}

/** Loads session history and compacts it before a turn when it nears the model context limit. */
export async function prepareSessionHistory(options: SessionHistoryOptions): Promise<ChatMessage[]> {
  const replay = options.session.replay()
  if (
    estimateContextTokens(replay.messages, options.staticContextChars) < autoCompactThreshold(options.contextLength)
  ) {
    return replay.messages
  }

  const result = await compactConversation(replay.messages, {
    client: options.client,
    signal: options.signal,
    onUsage: options.onUsage,
  })
  await options.session.compact(
    result.summary,
    result.keptMessages,
    keptToolActivities(result.keptMessages, replay.toolActivities),
  )
  return [compactionSummaryMessage(result.summary), ...result.keptMessages]
}

function keptToolActivities(messages: ChatMessage[], activities: SessionToolActivity[]) {
  const keptCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool_call") keptCallIds.add(part.toolCall.id)
    }
  }
  return activities.filter((activity) => keptCallIds.has(activity.toolCallId))
}
