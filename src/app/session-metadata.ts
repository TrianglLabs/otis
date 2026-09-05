import { isCompactionSummary } from "../core/compaction.js"
import { summarizeUserMessage, userMessageText } from "../inference/messages.js"
import type { ChatMessage, InferenceClient, TokenUsage } from "../inference/types.js"
import type { SessionSummary } from "../storage/index.js"

const GENERATED_TITLE_MAX_LENGTH = 60
const DISPLAY_TITLE_MAX_LENGTH = 36

export type SessionPickerItem = {
  id: string
  title: string
  detail: string
  active?: boolean
}

export function activeSessionLabel(messages: readonly ChatMessage[], title?: string) {
  if (title) return title
  const firstUser = messages.find((message) => message.role === "user" && !isCompactionSummary(message))
  return firstUser?.role === "user"
    ? formatSessionLabel(userMessageText(firstUser) || summarizeUserMessage(firstUser))
    : "Current session"
}

export function toSessionPickerItem(summary: SessionSummary, activeSessionId?: string): SessionPickerItem {
  return {
    id: summary.id,
    title: summary.title,
    detail: formatSessionAge(summary.updatedAt),
    active: summary.id === activeSessionId,
  }
}

export async function generateSessionTitle(
  messages: readonly ChatMessage[],
  options: { client: InferenceClient; onUsage?: (usage: TokenUsage) => void | Promise<void> },
): Promise<string | undefined> {
  const hasUser = messages.some((message) => message.role === "user" && !isCompactionSummary(message))
  if (!hasUser) return undefined

  const prompt = `Summarize this conversation in 3-6 words as a concise title. Output only the title, no quotes, no punctuation.

Conversation:
${serializeForTitle(messages)}`

  const title = await options.client.complete([{ role: "user", content: prompt }], { onUsage: options.onUsage })
  const cleaned = title
    .replace(/["“”']/g, "")
    .trim()
    .split("\n")[0]
    ?.trim()

  if (!cleaned) return undefined
  return cleaned.length > GENERATED_TITLE_MAX_LENGTH ? `${cleaned.slice(0, GENERATED_TITLE_MAX_LENGTH - 1)}…` : cleaned
}

export function formatSessionLabel(text: string) {
  const firstLine = text.trim().split("\n")[0]?.trim() || "Current session"
  return truncateMiddle(firstLine, DISPLAY_TITLE_MAX_LENGTH)
}

function serializeForTitle(messages: readonly ChatMessage[]) {
  const lines: string[] = []

  for (const message of messages.slice(0, 6)) {
    if (message.role === "user" && !isCompactionSummary(message)) {
      lines.push(`User: ${summarizeUserMessage(message).slice(0, 500)}`)
      continue
    }

    if (message.role !== "assistant") continue
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .slice(0, 500)
    if (text) lines.push(`Assistant: ${text}`)
  }

  return lines.join("\n")
}

function formatSessionAge(value: string) {
  const updatedAt = Date.parse(value)
  if (!Number.isFinite(updatedAt)) return "unknown"

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (elapsedSeconds < 60) return "now"

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h ago`

  return `${Math.floor(elapsedHours / 24)}d ago`
}

function truncateMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  const left = Math.ceil((maxLength - 1) / 2)
  const right = Math.floor((maxLength - 1) / 2)
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`
}
