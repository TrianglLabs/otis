import { requireLocalContextLength } from "./context-policy.js"
import { ContextOverflowError, inferenceResponseError } from "./errors.js"
import { inferenceEndpointURL, openaiChatCompletionRequest, requiredText } from "./openai-compat.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import type { ChatMessage, CompleteOptions, InferenceClient, StreamChatOptions } from "./types.js"

export type OpenAICompatibleClientConfig = {
  model: string
  inferenceURL: string
  modelLabel: string
  inferenceURLLabel: string
  requestLabel: string
  fetch?: typeof fetch
  apiKey?: string
}

/** Shared transport for local OpenAI-compatible inference servers. */
export class OpenAICompatibleClient implements InferenceClient {
  readonly model: string
  readonly #fetch: typeof fetch
  readonly #inferenceURL: string
  readonly #apiKey: string | undefined
  readonly #requestLabel: string

  constructor(config: OpenAICompatibleClientConfig) {
    this.model = requiredText(config.model, config.modelLabel)
    this.#fetch = config.fetch ?? fetch
    this.#inferenceURL = inferenceEndpointURL(config.inferenceURL, config.inferenceURLLabel)
    this.#apiKey = config.apiKey?.trim() || undefined
    this.#requestLabel = config.requestLabel
  }

  async *streamChat(options: StreamChatOptions) {
    try {
      const response = await this.request(options)
      if (!response.body) throw new Error(`${this.#requestLabel} response did not include a stream body`)
      yield* parseChatCompletionStream(response.body)
    } catch (error) {
      if (error instanceof ContextOverflowError) requireLocalContextLength(error.contextLength, this.#requestLabel)
      if (this.#apiKey && error instanceof Error) error.message = error.message.replaceAll(this.#apiKey, "[redacted]")
      throw error
    }
  }

  protected async request(options: StreamChatOptions, suffix = "") {
    const headers: Record<string, string> = {
      accept: suffix ? "application/json" : "text/event-stream",
      "content-type": "application/json",
    }
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`

    const url = new URL(this.#inferenceURL)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`
    const response = await this.#fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(this.requestBody(options)),
      signal: options.signal,
      redirect: "error",
    })

    if (!response.ok) throw await inferenceResponseError(response, this.#requestLabel)
    return response
  }

  protected requestBody(options: StreamChatOptions) {
    return openaiChatCompletionRequest(this.model, options)
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
