import type { ChatMessage } from "./types.js"

export const INVALID_TOOL_ARGUMENTS_RESULT =
  "This tool call failed because its arguments were not a complete JSON object. " +
  "The invalid arguments were omitted from this request. Generate a fresh call using smaller steps; " +
  "do not repeat earlier successful actions."

export function hasObjectArguments(argumentsJSON: string): boolean {
  try {
    const value: unknown = JSON.parse(argumentsJSON)
    return typeof value === "object" && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * A request-only projection: never mutate the transcript or guess missing tool input.
 * Keep call IDs and matching results, but replace malformed arguments with a valid
 * empty object and an explicit failure result. This also recovers older saved sessions.
 */
export function toolCallHistoryForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  const invalid = new Set<string>()
  const missing = new Set<string>()
  const finishBatch = () => {
    for (const toolCallId of missing) result.push({ role: "tool", toolCallId, content: INVALID_TOOL_ARGUMENTS_RESULT })
    missing.clear()
    invalid.clear()
  }
  for (const message of messages) {
    if (message.role !== "tool") finishBatch()
    if (message.role === "assistant") {
      const content = message.content.map((part) => {
        if (part.type !== "tool_call" || hasObjectArguments(part.toolCall.arguments)) return part
        invalid.add(part.toolCall.id)
        missing.add(part.toolCall.id)
        return { ...part, toolCall: { ...part.toolCall, arguments: "{}" } }
      })
      result.push(invalid.size ? { ...message, content } : message)
    } else if (message.role === "tool" && invalid.has(message.toolCallId)) {
      missing.delete(message.toolCallId)
      result.push({ ...message, content: INVALID_TOOL_ARGUMENTS_RESULT })
    } else result.push(message)
  }
  finishBatch()
  return result
}
