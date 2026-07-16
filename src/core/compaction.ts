import type { FireworksClient } from "../inference/client.js"
import type { ChatMessage, TokenUsage } from "../inference/types.js"

const CHARS_PER_TOKEN = 4
const TOKENS_PER_MESSAGE = 4
const DEFAULT_KEEP_RECENT_TOKENS = 20_000
const MIN_MESSAGES_TO_COMPACT = 4
export const AUTO_COMPACT_THRESHOLD_TOKENS = 250_000
const AUTO_COMPACT_CONTEXT_RATIO = 0.8

export function autoCompactThreshold(contextLength?: number) {
  if (contextLength === undefined) return AUTO_COMPACT_THRESHOLD_TOKENS
  if (!Number.isSafeInteger(contextLength) || contextLength <= 0) throw new Error("Model context length is invalid.")
  return Math.min(AUTO_COMPACT_THRESHOLD_TOKENS, Math.max(1, Math.floor(contextLength * AUTO_COMPACT_CONTEXT_RATIO)))
}

/**
 * Prefix that marks a user message as a compaction summary.
 * Used by {@link isCompactionSummary} to skip summary messages in display logic.
 */
export const COMPACTION_SUMMARY_PREFIX = "[Compacted conversation summary]"

export type CompactionResult = {
  summary: string
  keptMessages: ChatMessage[]
}

export type CompactionOptions = {
  client: FireworksClient
  instructions?: string
  onUsage?: (usage: TokenUsage) => void | Promise<void>
  signal?: AbortSignal
  keepRecentTokens?: number
}

export function compactionSummaryMessage(summary: string): ChatMessage {
  return { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` }
}

export function isCompactionSummary(message: ChatMessage): boolean {
  return message.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
}

/**
 * Extract the clean summary text from a compaction summary message,
 * stripping the {@link COMPACTION_SUMMARY_PREFIX} marker.
 */
export function extractCompactionSummary(message: ChatMessage): string {
  if (message.role !== "user") return ""
  const prefix = `${COMPACTION_SUMMARY_PREFIX}\n\n`
  return message.content.startsWith(prefix) ? message.content.slice(prefix.length) : message.content
}

/**
 * Compact a conversation by summarizing older messages while keeping recent ones.
 *
 * 1. Walk backwards from the newest message, accumulating token estimates
 *    until `keepRecentTokens` is reached.
 * 2. Adjust the cut point to a turn boundary (user message) so we never
 *    split a tool call from its results.
 * 3. Send the older messages to the LLM for a structured summary.
 * 4. Return the summary + kept messages so the caller can replace history.
 *
 * If the conversation is shorter than the keep budget, the last complete
 * turn is kept and everything before it is summarized. If there is only
 * one turn, compaction is refused.
 */
export async function compactConversation(
  messages: ChatMessage[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS

  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    throw new Error("Not enough conversation history to compact.")
  }

  const cutIndex = findCutPoint(messages, keepRecentTokens)
  if (cutIndex <= 0) {
    throw new Error("Not enough conversation history to compact.")
  }

  const messagesToSummarize = messages.slice(0, cutIndex)
  const keptMessages = messages.slice(cutIndex)

  const summary = await generateSummary(
    messagesToSummarize,
    options.client,
    options.instructions,
    options.signal,
    options.onUsage,
  )

  return { summary, keptMessages }
}

/**
 * Find the index at which to split the message array.
 * Messages before the index are summarized; messages from the index onwards are kept.
 * Returns 0 when there is nothing safe to summarize.
 */
function findCutPoint(messages: ChatMessage[], keepRecentTokens: number): number {
  const totalTokens = estimateTokens(messages)

  // Conversation fits within the keep budget — keep only the last complete turn.
  if (totalTokens <= keepRecentTokens) {
    return lastTurnStart(messages)
  }

  // Walk backwards until we've accumulated enough tokens to keep.
  let accumulated = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i])

    if (accumulated >= keepRecentTokens) {
      // Snap to the nearest user message (turn boundary) at or before this point.
      for (let j = i; j >= 1; j--) {
        if (messages[j].role === "user") return j
      }
      // The first turn alone exceeds the budget — keep the last turn instead.
      return lastTurnStart(messages)
    }
  }

  return 0
}

/**
 * Return the index of the user message that starts the last turn,
 * or 0 if there is only one turn (nothing to summarize).
 */
function lastTurnStart(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "user") return i
  }
  return 0
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  let messageCount = 0

  for (const message of messages) {
    chars += messageContentLength(message) + message.role.length
    messageCount += 1

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool_call") {
          chars += part.toolCall.id.length + part.toolCall.name.length + part.toolCall.arguments.length
        }
      }
    }

    if (message.role === "tool") {
      chars += message.toolCallId.length
    }
  }

  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN) + messageCount * TOKENS_PER_MESSAGE)
}

function estimateMessageTokens(message: ChatMessage): number {
  return estimateTokens([message])
}

function messageContentLength(message: ChatMessage): number {
  if (message.role === "user") return message.content.length
  if (message.role === "tool") return message.content.length
  return message.content.reduce((length, part) => {
    if (part.type === "text") return length + part.text.length
    if (part.type === "reasoning") return length + part.text.length
    return length
  }, 0)
}

async function generateSummary(
  messages: ChatMessage[],
  client: FireworksClient,
  instructions: string | undefined,
  signal?: AbortSignal,
  onUsage?: (usage: TokenUsage) => void | Promise<void>,
): Promise<string> {
  const prompt = buildSummarizationPrompt(messages, instructions)
  let text = ""

  for await (const event of client.streamChat({
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
  })) {
    if (event.type === "text_delta") text += event.text
    if (event.type === "usage") await onUsage?.(event.usage)
  }

  const trimmed = text.trim()
  if (!trimmed) throw new Error("Compaction failed: the model returned an empty summary.")
  return trimmed
}

function buildSummarizationPrompt(messages: ChatMessage[], instructions?: string): string {
  const conversation = serializeConversation(messages)
  const focus = instructions ? `\nAdditional focus for this summary: ${instructions}\n` : ""

  return `You are summarizing a conversation to compact context. Produce a structured summary that preserves all critical information needed to continue the work. Be concise but thorough — do not omit important details, decisions, or context.

Use this format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data, file paths, error messages, or other details needed to continue]
${focus}
Conversation to summarize:

${conversation}`
}

function serializeConversation(messages: ChatMessage[]): string {
  const lines: string[] = []

  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`User: ${truncate(message.content, 8000)}`)
    } else if (message.role === "assistant") {
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
        } else if (part.type === "tool_call") {
          parts.push(`[Tool call: ${part.toolCall.name}(${truncate(part.toolCall.arguments, 500)})]`)
        }
      }
      lines.push(`Assistant: ${truncate(parts.join("\n"), 8000)}`)
    } else if (message.role === "tool") {
      lines.push(`Tool result: ${truncate(message.content, 2000)}`)
    }
  }

  return lines.join("\n\n")
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…[truncated]`
}
