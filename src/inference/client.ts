import { inferenceEndpointURL, openaiChatCompletionRequest, requiredText, responsePreview } from "./openai-compat.js"
import { highestReasoningEffort } from "./reasoning.js"
import { fireworksServiceTier } from "./serving-path.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import type {
  ChatMessage,
  CompleteOptions,
  FireworksClientConfig,
  InferenceClient,
  StreamChatOptions,
} from "./types.js"

export { listToolCapableModels } from "./catalog.js"
export type { InferenceClient } from "./types.js"

const DEFAULT_INFERENCE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"

export class FireworksClient implements InferenceClient {
  readonly model: string
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #inferenceURL: string

  constructor(config: FireworksClientConfig) {
    this.#apiKey = requiredText(config.apiKey, "Fireworks API key")
    this.model = requiredText(config.model, "Fireworks model")
    this.#fetch = config.fetch ?? fetch
    this.#inferenceURL = inferenceEndpointURL(config.inferenceURL ?? DEFAULT_INFERENCE_URL, "Fireworks inference URL")
  }

  async *streamChat(options: StreamChatOptions) {
    const response = await this.#fetch(this.#inferenceURL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        openaiChatCompletionRequest(this.model, options, {
          reasoningEffort: highestReasoningEffort(this.model),
          serviceTier: fireworksServiceTier(this.model),
        }),
      ),
      signal: options.signal,
    })

    if (!response.ok) {
      throw new Error(`Fireworks request failed with HTTP ${response.status}: ${await responsePreview(response)}`)
    }
    if (!response.body) throw new Error("Fireworks response did not include a stream body")
    yield* parseChatCompletionStream(response.body)
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
