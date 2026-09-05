import { summarizeUserMessage, userMessageText } from "../inference/messages.js"
import type { ChatMessage, InferenceClient, TokenUsage } from "../inference/types.js"

import { estimateMessageTokens, requestContextEstimator } from "./context-tokens.js"

const DEFAULT_KEEP_RECENT_TOKENS = 20_000
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
  client: InferenceClient
  instructions?: string
  onUsage?: (usage: TokenUsage) => void | Promise<void>
  signal?: AbortSignal
  keepRecentTokens?: number
  /** Maximum estimated context after compaction, including the summary and static prompt. */
  targetTokens?: number
  estimateContextTokens?: (messages: ChatMessage[]) => number
  /** Bounds each summarization request when resuming an oversized conversation. */
  maxInputTokens?: number
}

export function compactionSummaryMessage(summary: string): ChatMessage {
  return { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` }
}

export function isCompactionSummary(message: ChatMessage): boolean {
  return message.role === "user" && userMessageText(message).startsWith(COMPACTION_SUMMARY_PREFIX)
}

/**
 * Extract the clean summary text from a compaction summary message,
 * stripping the {@link COMPACTION_SUMMARY_PREFIX} marker.
 */
export function extractCompactionSummary(message: ChatMessage): string {
  if (message.role !== "user") return ""
  const content = userMessageText(message)
  const prefix = `${COMPACTION_SUMMARY_PREFIX}\n\n`
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

/** Summarizes a prefix, retaining whole tool exchanges and any unanswered user messages. */
export async function compactConversation(
  messages: ChatMessage[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  options.signal?.throwIfAborted()
  const targetTokens = options.targetTokens ?? Math.floor(AUTO_COMPACT_THRESHOLD_TOKENS / 2)
  const keepRecentTokens = Math.min(
    options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    Math.floor(targetTokens / 2),
  )
  const cutIndex = findCutPoint(messages, keepRecentTokens)
  if (cutIndex <= 0) throw new Error("Not enough conversation history to compact.")

  const keptMessages = messages.slice(cutIndex)
  const estimate = options.estimateContextTokens ?? estimateMessageTokens
  if (estimate(keptMessages) >= targetTokens) {
    throw new Error(
      "The latest input and fixed context leave no room for a compaction summary. Reduce the input or project context.",
    )
  }
  const summary = await generateSummary(messages.slice(0, cutIndex), options)
  options.signal?.throwIfAborted()
  const compacted = [compactionSummaryMessage(summary), ...keptMessages]
  if (estimate(compacted) > targetTokens || estimate(compacted) >= estimate(messages)) {
    throw new Error("Compaction did not free enough context. The conversation was left unchanged.")
  }
  return { summary, keptMessages }
}

/** Prefer user boundaries; split long turns only between complete tool exchanges. */
function findCutPoint(messages: ChatMessage[], keepRecentTokens: number): number {
  // Never summarize a prompt that has not received a response yet.
  let lastCut = messages.length
  while (lastCut > 0 && messages[lastCut - 1].role === "user") lastCut -= 1
  if (lastCut === 0) return 0

  const suffixTokens = new Array<number>(messages.length + 1).fill(0)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = suffixTokens[index + 1] + estimateMessageTokens([messages[index]])
  }
  const pendingCalls = new Set<string>()
  const boundaries: number[] = []
  let hasHistory = false
  for (let index = 0; index < lastCut; index += 1) {
    const message = messages[index]
    if (!isCompactionSummary(message)) hasHistory = true
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool_call") pendingCalls.add(part.toolCall.id)
      }
    } else if (message.role === "tool") pendingCalls.delete(message.toolCallId)
    const cut = index + 1
    if (hasHistory && pendingCalls.size === 0 && messages[cut]?.role !== "tool") boundaries.push(cut)
  }
  if (suffixTokens[0] <= keepRecentTokens) {
    const lastUser = [...boundaries].reverse().find((cut) => messages[cut]?.role === "user")
    if (lastUser !== undefined) return lastUser
  }
  const fitting = boundaries.filter((cut) => suffixTokens[cut] <= keepRecentTokens)
  return (
    fitting.find((cut) => messages[cut]?.role === "user") ?? fitting[0] ?? (boundaries.includes(lastCut) ? lastCut : 0)
  )
}

async function generateSummary(messages: ChatMessage[], options: CompactionOptions): Promise<string> {
  const conversation = serializeConversation(messages)
  const estimate = requestContextEstimator({ tools: [] })
  const maxInputTokens = options.maxInputTokens ?? AUTO_COMPACT_THRESHOLD_TOKENS
  let summary = ""
  let offset = 0
  while (offset < conversation.length) {
    options.signal?.throwIfAborted()
    const previous = summary ? `Previous summary:\n${summary}\n\nMore conversation:\n` : ""
    const overhead = estimate([{ role: "user", content: buildSummarizationPrompt(previous, options.instructions) }])
    const availableChars = Math.floor((maxInputTokens - overhead) * 4)
    if (availableChars <= 0) throw new Error("The summary is too large to compact within the context budget.")
    let end = Math.min(conversation.length, offset + availableChars)
    // A chunk boundary must not turn a Unicode surrogate pair into two invalid strings.
    const lastCodeUnit = conversation.charCodeAt(end - 1)
    const nextCodeUnit = conversation.charCodeAt(end)
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) end -= 1
    if (end <= offset) throw new Error("The context budget is too small for a summary request.")
    const chunk = conversation.slice(offset, end)
    const prompt = buildSummarizationPrompt(previous + chunk, options.instructions)
    let text = ""
    for await (const event of options.client.streamChat({
      messages: [{ role: "user", content: prompt }],
      tools: [],
      signal: options.signal,
    })) {
      if (event.type === "text_delta") text += event.text
      if (event.type === "usage") await options.onUsage?.(event.usage)
      if (event.type === "finish" && event.reason !== "stop") {
        throw new Error(
          `Compaction failed: the model did not finish its summary (${event.reason}). The conversation was left unchanged.`,
        )
      }
    }
    options.signal?.throwIfAborted()
    summary = text.trim()
    if (!summary) throw new Error("Compaction failed: the model returned an empty summary.")
    offset += chunk.length
  }
  return summary
}

function buildSummarizationPrompt(conversation: string, instructions?: string): string {
  const focus = instructions ? `\nAdditional focus for this summary: ${instructions}\n` : ""

  return `You are summarizing a conversation to compact context. Produce a structured summary that preserves all critical information needed to continue the work. Keep the summary concise (aim for at most 2,000 tokens). Preserve the current task, user instructions, decisions, and details needed for the next action.

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
      lines.push(`User: ${summarizeUserMessage(message)}`)
    } else if (message.role === "assistant") {
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
        } else if (part.type === "tool_call") {
          parts.push(`[Tool call: ${part.toolCall.name}(${part.toolCall.arguments})]`)
        }
      }
      lines.push(`Assistant: ${parts.join("\n")}`)
    } else if (message.role === "tool") {
      lines.push(`Tool result: ${message.content}`)
    }
  }

  return lines.join("\n\n")
}
