import type { ChatStreamEvent, OpenAICompatibleReasoningField, TokenUsage } from "./types.js"

export async function* parseChatCompletionStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state: StreamParserState = { toolCalls: new Map() }
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = sseEventSeparator(buffer)
      while (separator) {
        const [index, length] = separator
        yield* processSSEEvent(buffer.slice(0, index), state)
        buffer = buffer.slice(index + length)
        separator = sseEventSeparator(buffer)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) yield* processSSEEvent(buffer, state)
  } finally {
    reader.releaseLock()
  }

  yield* flushToolCalls(state)
}

function* processSSEEvent(rawEvent: string, state: StreamParserState): Generator<ChatStreamEvent> {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")

  if (!data || data === "[DONE]") return

  for (const chunk of parseSSEChunks(data)) {
    if (chunk.error) throw new Error(`Inference stream failed: ${providerError(chunk.error)}`)

    const usage = parseUsage(chunk.usage)
    if (usage) yield { type: "usage", usage }

    const choice = chunk.choices?.[0]
    if (choice?.finish_reason) state.finishReason = choice.finish_reason

    const delta = choice?.delta
    const reasoning = reasoningDelta(delta)
    if (reasoning) yield { type: "reasoning_delta", ...reasoning }
    if (delta?.content) yield { type: "text_delta", text: delta.content }

    const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
    toolCalls.forEach((toolCall, position) => {
      appendToolCallDelta(state, toolCall, position, toolCalls.length)
    })
  }
}

function appendToolCallDelta(state: StreamParserState, raw: RawToolCall, position: number, batchLength: number) {
  const index = resolveToolCallIndex(state, raw, position, batchLength)
  const existing = state.toolCalls.get(index) ?? { arguments: "" }
  state.toolCalls.set(index, {
    id: nonEmptyString(raw.id) ?? existing.id,
    name: nonEmptyString(raw.function?.name) ?? existing.name,
    arguments: existing.arguments + (typeof raw.function?.arguments === "string" ? raw.function.arguments : ""),
  })
  state.currentToolCallIndex = index
}

function resolveToolCallIndex(state: StreamParserState, raw: RawToolCall, position: number, batchLength: number) {
  if (typeof raw.index === "number") return raw.index
  if (raw.id) {
    for (const [index, toolCall] of state.toolCalls) {
      if (toolCall.id === raw.id) return index
    }
    return nextToolCallIndex(state)
  }
  if (batchLength > 1) return position
  return state.currentToolCallIndex ?? nextToolCallIndex(state)
}

function nextToolCallIndex(state: StreamParserState) {
  return state.toolCalls.size === 0 ? 0 : Math.max(...state.toolCalls.keys()) + 1
}

function* flushToolCalls(state: StreamParserState): Generator<ChatStreamEvent> {
  if (state.toolCalls.size === 0) {
    if (state.finishReason === "tool_calls" || state.finishReason === "function_call") {
      throw new Error(`Fireworks stream ended with finish_reason=${state.finishReason} but included no tool calls`)
    }
    return
  }

  for (const [index, toolCall] of [...state.toolCalls].sort(([left], [right]) => left - right)) {
    if (!toolCall.name) throw new Error("Fireworks stream included a tool call without a function name")
    yield {
      type: "tool_call",
      toolCall: { id: toolCall.id || `call_${index}`, name: toolCall.name, arguments: toolCall.arguments },
    }
  }
}

function reasoningDelta(delta: RawChatCompletionDelta | null | undefined) {
  if (!delta) return undefined
  for (const field of REASONING_FIELDS) {
    const text = delta[field]
    if (text) return { field, text }
  }
  return undefined
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const promptTokens = nonNegativeInteger(value.prompt_tokens)
  const completionTokens = nonNegativeInteger(value.completion_tokens)
  const totalTokens = nonNegativeInteger(value.total_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  return { promptTokens, completionTokens, totalTokens: totalTokens ?? promptTokens + completionTokens }
}

function parseSSEChunks(data: string): RawChatCompletionChunk[] {
  const trimmed = data.trim()
  if (!trimmed || trimmed === "[DONE]") return []
  try {
    return [JSON.parse(trimmed) as RawChatCompletionChunk]
  } catch (error) {
    const lines = trimmed
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && line !== "[DONE]")
    if (lines.length > 1) {
      try {
        return lines.map((line) => JSON.parse(line) as RawChatCompletionChunk)
      } catch (lineError) {
        throw new Error(`Invalid Fireworks stream event: ${errorMessage(lineError)}`)
      }
    }
    throw new Error(`Invalid Fireworks stream event: ${errorMessage(error)}`)
  }
}

function sseEventSeparator(buffer: string): [number, number] | undefined {
  const lf = buffer.indexOf("\n\n")
  const crlf = buffer.indexOf("\r\n\r\n")
  if (lf === -1) return crlf === -1 ? undefined : [crlf, 4]
  if (crlf === -1 || lf < crlf) return [lf, 2]
  return [crlf, 4]
}

function providerError(value: unknown) {
  if (isRecord(value) && typeof value.message === "string") return value.message
  return typeof value === "string" ? value : "unknown provider error"
}

const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const satisfies readonly OpenAICompatibleReasoningField[]

type StreamParserState = {
  toolCalls: Map<number, PendingToolCall>
  currentToolCallIndex?: number
  finishReason?: string
}

type PendingToolCall = { id?: string; name?: string; arguments: string }

type RawChatCompletionChunk = {
  choices?: Array<{ finish_reason?: string | null; delta?: RawChatCompletionDelta | null }>
  usage?: unknown
  error?: unknown
}

type RawChatCompletionDelta = {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  reasoning_text?: string | null
  tool_calls?: RawToolCall[] | null
}

type RawToolCall = {
  index?: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null } | null
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
