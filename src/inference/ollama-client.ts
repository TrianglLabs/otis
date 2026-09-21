import { randomUUID } from "node:crypto"
import { requireLocalContextLength } from "./context-policy.js"
import { ContextOverflowError, inferenceError, inferenceResponseError } from "./errors.js"
import { normalizeLocalBaseURL } from "./local-endpoint.js"
import { formatDocumentForModel } from "./messages.js"
import { openaiChatCompletionRequest, requiredText } from "./openai-compat.js"
import { toolCallHistoryForRequest } from "./tool-call-history.js"
import type { ChatMessage, ChatStreamEvent, CompleteOptions, InferenceClient, StreamChatOptions } from "./types.js"

/** Ollama's OpenAI route cannot disable history truncation; use its native chat route, including through PAIR. */
export class OllamaClient implements InferenceClient {
  readonly model: string
  readonly #url: string
  readonly #fetch: typeof fetch

  constructor(config: { model: string; baseURL: string; fetch?: typeof fetch }) {
    this.model = requiredText(config.model, "Ollama model")
    this.#url = `${normalizeLocalBaseURL(config.baseURL)}/api/chat`
    this.#fetch = config.fetch ?? fetch
  }

  async *streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
    try {
      // Reuse attachment validation and the same system prompt/tool serialization as every other transport.
      const request = openaiChatCompletionRequest(this.model, options)
      const messages = toolCallHistoryForRequest(options.messages)
      const names = new Map<string, string>()
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { accept: "application/x-ndjson", "content-type": "application/json" },
        signal: options.signal,
        redirect: "error",
        body: JSON.stringify({
          model: this.model,
          messages: [request.messages[0], ...messages.map((message) => ollamaMessage(message, names))],
          ...(request.tools ? { tools: request.tools } : {}),
          stream: true,
          truncate: false,
          shift: false,
        }),
      })
      if (!response.ok) throw await inferenceResponseError(response, "Ollama")
      if (!response.body) throw new Error("Ollama response did not include a stream body")
      yield* parseOllamaStream(response.body)
    } catch (error) {
      if (error instanceof ContextOverflowError) requireLocalContextLength(error.contextLength, "Ollama")
      throw error
    }
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    let text = ""
    for await (const event of this.streamChat({
      messages,
      projectContext: options.projectContext,
      signal: options.signal,
      tools: [],
    })) {
      if (event.type === "text_delta") text += event.text
      if (event.type === "usage") await options.onUsage?.(event.usage)
    }
    return text.trim()
  }
}

function ollamaMessage(message: ChatMessage, names: Map<string, string>) {
  if (message.role === "user") {
    if (typeof message.content === "string") return message
    return {
      role: "user",
      content: message.content
        .filter((part) => part.type !== "image")
        .map((part) => (part.type === "document" ? formatDocumentForModel(part) : part.text))
        .join("\n"),
      images: message.content.filter((part) => part.type === "image").map((part) => part.data),
    }
  }
  if (message.role === "tool")
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      tool_name: names.get(message.toolCallId),
    }
  const calls = message.content.flatMap((part) => {
    if (part.type !== "tool_call") return []
    names.set(part.toolCall.id, part.toolCall.name)
    return [
      { id: part.toolCall.id, function: { name: part.toolCall.name, arguments: JSON.parse(part.toolCall.arguments) } },
    ]
  })
  return {
    role: "assistant",
    content: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    thinking: message.content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .join(""),
    ...(calls.length ? { tool_calls: calls } : {}),
  }
}

type OllamaChunk = {
  error?: string
  message?: {
    content?: string
    thinking?: string
    tool_calls?: Array<{ id?: string; function: { name: string; arguments: unknown } }>
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

async function* parseOllamaStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false
  try {
    while (!finished) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let index = buffer.indexOf("\n")
      while (index !== -1 || (done && buffer.trim())) {
        const line = index === -1 ? buffer : buffer.slice(0, index)
        buffer = index === -1 ? "" : buffer.slice(index + 1)
        if (line.trim()) {
          const chunk = JSON.parse(line) as OllamaChunk
          if (chunk.error) throw inferenceError(`Ollama stream failed: ${chunk.error}`, chunk.error)
          if (chunk.message?.thinking)
            yield { type: "reasoning_delta", field: "reasoning", text: chunk.message.thinking }
          if (chunk.message?.content) yield { type: "text_delta", text: chunk.message.content }
          for (const call of chunk.message?.tool_calls ?? []) {
            if (!call.function?.name) throw new Error("Ollama returned a tool call without a function name")
            yield {
              type: "tool_call",
              toolCall: {
                id: call.id || `call_${randomUUID()}`,
                name: call.function.name,
                arguments: JSON.stringify(call.function.arguments) ?? "",
              },
            }
          }
          if (chunk.done) {
            const promptTokens = chunk.prompt_eval_count
            const completionTokens = chunk.eval_count
            if (
              typeof promptTokens === "number" &&
              typeof completionTokens === "number" &&
              Number.isSafeInteger(promptTokens) &&
              Number.isSafeInteger(completionTokens) &&
              promptTokens >= 0 &&
              completionTokens >= 0
            ) {
              yield {
                type: "usage",
                usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
              }
            }
            yield { type: "finish", reason: chunk.done_reason || "stop" }
            finished = true
            break
          }
        }
        index = buffer.indexOf("\n")
      }
      if (done) break
    }
    if (!finished) throw new Error("Ollama stream ended before completing the response")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
