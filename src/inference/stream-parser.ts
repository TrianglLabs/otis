import { errorMessage, inferenceError, isRecord } from "./errors.js"
import type { ChatStreamEvent, OpenAICompatibleReasoningField } from "./types.js"

const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const satisfies readonly OpenAICompatibleReasoningField[]

type RawToolCall = {
  index?: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null } | null
}

type RawChatCompletionChunk = {
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      reasoning_text?: string | null
      tool_calls?: RawToolCall[] | null
    } | null
  }>
  usage?: unknown
  error?: unknown
}

export async function* parseChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>()
  let currentToolCallIndex: number | undefined
  let finishReason: string | undefined
  let buffer = ""

  function* processEvent(rawEvent: string): Generator<ChatStreamEvent> {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") return

    let chunks: RawChatCompletionChunk[]
    try {
      chunks = [JSON.parse(data)]
    } catch (error) {
      // Some servers pack several JSON chunks into one event, one per line.
      const lines = data
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line && line !== "[DONE]")
      try {
        if (lines.length < 2) throw error
        chunks = lines.map((line) => JSON.parse(line))
      } catch (lineError) {
        throw new Error(`Invalid inference stream event: ${errorMessage(lineError)}`)
      }
    }

    for (const chunk of chunks) {
      if (chunk.error) {
        const detail = chunk.error
        const text =
          isRecord(detail) && typeof detail.message === "string"
            ? detail.message
            : typeof detail === "string"
              ? detail
              : "unknown provider error"
        throw inferenceError(`Inference stream failed: ${text}`, detail)
      }

      if (isRecord(chunk.usage)) {
        const promptTokens = nonNegativeInteger(chunk.usage.prompt_tokens)
        const completionTokens = nonNegativeInteger(chunk.usage.completion_tokens)
        if (promptTokens !== undefined && completionTokens !== undefined) {
          const totalTokens =
            nonNegativeInteger(chunk.usage.total_tokens) ?? promptTokens + completionTokens
          yield { type: "usage", usage: { promptTokens, completionTokens, totalTokens } }
        }
      }

      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const delta = choice?.delta
      for (const field of REASONING_FIELDS) {
        const text = delta?.[field]
        if (!text) continue
        yield { type: "reasoning_delta", field, text }
        break
      }
      if (delta?.content) yield { type: "text_delta", text: delta.content }

      const deltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
      for (const [position, raw] of deltas.entries()) {
        const next = () => (toolCalls.size === 0 ? 0 : Math.max(...toolCalls.keys()) + 1)
        let index: number
        if (typeof raw.index === "number") index = raw.index
        else if (raw.id)
          index = [...toolCalls].find(([, call]) => call.id === raw.id)?.[0] ?? next()
        else if (deltas.length > 1) index = position
        else index = currentToolCallIndex ?? next()
        const existing = toolCalls.get(index) ?? { arguments: "" }
        toolCalls.set(index, {
          id: nonEmptyString(raw.id) ?? existing.id,
          name: nonEmptyString(raw.function?.name) ?? existing.name,
          arguments: existing.arguments + (nonEmptyString(raw.function?.arguments) ?? ""),
        })
        currentToolCallIndex = index
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const lf = buffer.indexOf("\n\n")
        const crlf = buffer.indexOf("\r\n\r\n")
        if (lf === -1 && crlf === -1) break
        const [index, length] = crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : [lf, 2]
        yield* processEvent(buffer.slice(0, index))
        buffer = buffer.slice(index + length)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* processEvent(buffer)
  } finally {
    reader.releaseLock()
  }

  if (toolCalls.size === 0 && (finishReason === "tool_calls" || finishReason === "function_call")) {
    throw new Error(
      `Inference stream ended with finish_reason=${finishReason} but included no tool calls`,
    )
  }
  for (const [index, toolCall] of [...toolCalls].sort(([left], [right]) => left - right)) {
    if (!toolCall.name)
      throw new Error("Inference stream included a tool call without a function name")
    yield {
      type: "tool_call",
      toolCall: {
        id: toolCall.id || `call_${index}`,
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }
  }
  if (finishReason) yield { type: "finish", reason: finishReason }
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}
