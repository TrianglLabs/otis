import { userMessageContentChars } from "../inference/messages.js"
import type { ChatMessage } from "../inference/types.js"
import { TOOL_DEFINITIONS } from "../tools/index.js"
import { colors } from "./theme.js"

const CHARS_PER_TOKEN = 4
const TOKENS_PER_MESSAGE = 4
const SYSTEM_PROMPT_ESTIMATE_TOKENS = 1_000
const METER_BLOCKS = 8
const toolDefinitionChars = JSON.stringify(TOOL_DEFINITIONS).length

export function estimateContextTokens(
  messages: readonly ChatMessage[],
  staticContextChars: number,
  pendingInput: string | number = "",
) {
  const pendingChars = typeof pendingInput === "number" ? pendingInput : pendingInput.length
  let chars = toolDefinitionChars + staticContextChars + pendingChars
  let messageCount = 1 + messages.length

  if (pendingChars > 0) messageCount += 1

  for (const message of messages) {
    chars += message.role.length + messageContentLength(message)

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool_call") continue
        chars += part.toolCall.id.length + part.toolCall.name.length + part.toolCall.arguments.length
      }
    }

    if (message.role === "tool") chars += message.toolCallId.length
  }

  return estimateTokens(chars, messageCount)
}

export function estimateTokens(contentChars: number, messageCount: number) {
  return (
    SYSTEM_PROMPT_ESTIMATE_TOKENS +
    Math.max(0, Math.ceil(contentChars / CHARS_PER_TOKEN)) +
    messageCount * TOKENS_PER_MESSAGE
  )
}

export function estimateAgentContextTokens(contentChars: number, messageCount: number, staticContextChars: number) {
  return estimateTokens(toolDefinitionChars + staticContextChars + contentChars, messageCount)
}

export function contextUsage(usedTokens: number, contextWindowTokens: number) {
  const percent = contextWindowTokens > 0 ? (usedTokens / contextWindowTokens) * 100 : 0
  return {
    usedTokens,
    contextWindowTokens,
    percent: Math.min(100, Math.max(0, percent)),
  }
}

export function formatContextUsage(usage: ReturnType<typeof contextUsage>) {
  return `${contextMeter(usage.percent)} ${formatPercent(usage.percent)} · ~${formatTokenCount(usage.usedTokens)}`
}

export function contextUsageColor(percent: number) {
  if (percent >= 90) return colors.pink
  if (percent >= 70) return colors.yellow
  return colors.muted
}

function messageContentLength(message: ChatMessage) {
  if (message.role === "user") return userMessageContentChars(message)
  if (message.role === "tool") return message.content.length

  return message.content.reduce((length, part) => {
    if (part.type === "text" || part.type === "reasoning") return length + part.text.length
    return length
  }, 0)
}

function contextMeter(percent: number) {
  const filled = Math.min(METER_BLOCKS, Math.max(0, Math.floor((percent / 100) * METER_BLOCKS)))
  return `${"■".repeat(filled)}${"□".repeat(METER_BLOCKS - filled)}`
}

function formatPercent(percent: number) {
  if (percent > 0 && percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

function formatTokenCount(tokens: number) {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`
  return `${Math.round(tokens / 100_000) / 10}M`
}
