import { userMessageContentChars } from "../inference/messages.js"
import { openaiTool } from "../inference/openai-compat.js"
import { buildSystemPrompt } from "../inference/system-prompt.js"
import type { ChatMessage, StreamChatOptions } from "../inference/types.js"

export function messageContentChars(message: ChatMessage): number {
  let chars = message.role.length
  if (message.role === "user") return chars + userMessageContentChars(message)
  if (message.role === "tool") return chars + message.toolCallId.length + message.content.length
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") chars += part.text.length
    else chars += part.toolCall.id.length + part.toolCall.name.length + part.toolCall.arguments.length
  }
  return chars
}

export function messagesContentChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageContentChars(message), 0)
}

export function estimateMessageTokens(messages: readonly ChatMessage[]): number {
  return Math.ceil(messagesContentChars(messages) / 4) + messages.length * 4
}

/** Shared estimate for request checks, summary budgets, and the context meter. */
export function requestContextEstimator(options: Omit<StreamChatOptions, "messages">) {
  const staticChars =
    buildSystemPrompt(options.projectContext, options.now, options.skills, options.tools).length +
    JSON.stringify((options.tools ?? []).map(openaiTool)).length
  return (messages: readonly ChatMessage[]) => Math.ceil(staticChars / 4) + 4 + estimateMessageTokens(messages)
}
