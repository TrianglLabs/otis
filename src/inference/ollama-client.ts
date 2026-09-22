import { randomUUID } from "node:crypto"
import { requireLocalContextLength } from "./context-policy.js"
import { ContextOverflowError, inferenceError, inferenceResponseError } from "./errors.js"
import { formatDocumentForModel, textContent } from "./messages.js"
import {
  collectCompletionText,
  fetchWithIdleTimeout,
  LOCAL_IDLE_TIMEOUT_MS,
  normalizeLocalBaseURL,
  openaiChatCompletionRequest,
  requiredText,
  toolCallHistoryForRequest,
} from "./openai-compat.js"
import type {
  ChatMessage,
  ChatStreamEvent,
  CompleteOptions,
  InferenceClient,
  StreamChatOptions,
} from "./types.js"

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

/**
 * Ollama's OpenAI route cannot disable history truncation; use its native chat route, including
 * through PAIR.
 */
export class OllamaClient implements InferenceClient {
  readonly model: string
  readonly #url: string
  readonly #fetch: typeof fetch
  readonly #idleTimeoutMs: number

  constructor(config: {
    model: string
    baseURL: string
    fetch?: typeof fetch
    idleTimeoutMs?: number
  }) {
    this.model = requiredText(config.model, "Ollama model")
    this.#url = `${normalizeLocalBaseURL(config.baseURL)}/api/chat`
    this.#fetch = config.fetch ?? fetch
    this.#idleTimeoutMs = config.idleTimeoutMs ?? LOCAL_IDLE_TIMEOUT_MS
  }

  async *streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
    try {
      // Reuse attachment validation and the same system prompt/tool serialization as every
      // other transport.
      const request = openaiChatCompletionRequest(this.model, options)
      const names = new Map<string, string>()
      const response = await fetchWithIdleTimeout(
        this.#fetch,
        this.#url,
        {
          method: "POST",
          headers: { accept: "application/x-ndjson", "content-type": "application/json" },
          signal: options.signal,
          redirect: "error",
          body: JSON.stringify({
            model: this.model,
            messages: [
              request.messages[0],
              ...toolCallHistoryForRequest(options.messages).map((message) => {
                if (message.role === "user") {
                  if (typeof message.content === "string") return message
                  return {
                    role: "user",
                    content: message.content
                      .filter((part) => part.type !== "image")
                      .map((part) =>
                        part.type === "document" ? formatDocumentForModel(part) : part.text,
                      )
                      .join("\n"),
                    images: message.content
                      .filter((part) => part.type === "image")
                      .map((part) => part.data),
                  }
                }
                if (message.role === "tool") {
                  return {
                    role: "tool",
                    content: message.content,
                    tool_call_id: message.toolCallId,
                    tool_name: names.get(message.toolCallId),
                  }
                }
                const calls = message.content.flatMap((part) => {
                  if (part.type !== "tool_call") return []
                  names.set(part.toolCall.id, part.toolCall.name)
                  const { id, name } = part.toolCall
                  return [
                    { id, function: { name, arguments: JSON.parse(part.toolCall.arguments) } },
                  ]
                })
                return {
                  role: "assistant",
                  content: textContent(message.content),
                  thinking: message.content
                    .map((part) => (part.type === "reasoning" ? part.text : ""))
                    .join(""),
                  ...(calls.length ? { tool_calls: calls } : {}),
                }
              }),
            ],
            ...(request.tools ? { tools: request.tools } : {}),
            stream: true,
            truncate: false,
            shift: false,
          }),
        },
        this.#idleTimeoutMs,
        "Ollama",
      )
      if (!response.ok) throw await inferenceResponseError(response, "Ollama")
      if (!response.body) throw new Error("Ollama response did not include a stream body")

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let finished = false
      try {
        while (!finished) {
          const { value, done } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          const lines = buffer.split("\n")
          buffer = done ? "" : (lines.pop() ?? "")
          for (const line of lines) {
            if (!line.trim()) continue
            const chunk = JSON.parse(line) as OllamaChunk
            if (chunk.error)
              throw inferenceError(`Ollama stream failed: ${chunk.error}`, chunk.error)
            if (chunk.message?.thinking) {
              yield { type: "reasoning_delta", field: "reasoning", text: chunk.message.thinking }
            }
            if (chunk.message?.content) yield { type: "text_delta", text: chunk.message.content }
            for (const call of chunk.message?.tool_calls ?? []) {
              if (!call.function?.name)
                throw new Error("Ollama returned a tool call without a function name")
              yield {
                type: "tool_call",
                toolCall: {
                  id: call.id || `call_${randomUUID()}`,
                  name: call.function.name,
                  arguments: JSON.stringify(call.function.arguments) ?? "",
                },
              }
            }
            if (!chunk.done) continue
            const promptTokens = chunk.prompt_eval_count ?? -1
            const completionTokens = chunk.eval_count ?? -1
            if (
              Number.isSafeInteger(promptTokens) &&
              Number.isSafeInteger(completionTokens) &&
              promptTokens >= 0 &&
              completionTokens >= 0
            ) {
              yield {
                type: "usage",
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                },
              }
            }
            yield { type: "finish", reason: chunk.done_reason || "stop" }
            finished = true
            break
          }
          if (done) break
        }
        if (!finished) throw new Error("Ollama stream ended before completing the response")
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } catch (error) {
      if (error instanceof ContextOverflowError)
        requireLocalContextLength(error.contextLength, "Ollama")
      throw error
    }
  }

  complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    return collectCompletionText(this, messages, options)
  }
}
