import { autoCompactThreshold, compactConversation, compactionSummaryMessage } from "../core/compaction.js"
import type { InferenceClient } from "../inference/client.js"
import type { ChatMessage, TokenUsage } from "../inference/types.js"
import { forToolCalls, type JsonlSession } from "../storage/index.js"
import { estimateContextTokens } from "./context-meter.js"

type SessionHistoryOptions = {
  session: JsonlSession
  client: InferenceClient
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
  await options.session.compact(result.summary, result.keptMessages, {
    toolActivities: forToolCalls(replay.toolActivities, result.keptMessages),
    subagents: forToolCalls(replay.subagents, result.keptMessages),
  })
  return [compactionSummaryMessage(result.summary), ...result.keptMessages]
}
