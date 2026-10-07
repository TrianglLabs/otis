import { inferenceResponseError } from "./errors.js"
import {
  collectCompletionText,
  DEFAULT_IDLE_TIMEOUT_MS,
  fetchWithIdleTimeout,
  inferenceEndpointURL,
  openaiChatCompletionRequest,
  requiredText,
} from "./openai-compat.js"
import { fireworksServiceTier } from "./serving-path.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import {
  type ChatMessage,
  type CompleteOptions,
  HOSTED_PROVIDER_INFO,
  type HostedClientConfig,
  type HostedProvider,
  type InferenceClient,
  type StreamChatOptions,
} from "./types.js"

export { listHostedModels } from "./catalog.js"
export type { InferenceClient } from "./types.js"

/**
 * A hosted provider's OpenAI-compatible chat completions, called with the user's own key. Only
 * Fireworks documents reasoning tiers and a priority service tier; the others keep their
 * defaults.
 */
export class HostedClient implements InferenceClient {
  readonly provider: HostedProvider
  readonly model: string
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #inferenceURL: string
  readonly #idleTimeoutMs: number
  readonly #teamId: string | undefined

  constructor(config: HostedClientConfig) {
    const { name, inferenceURL } = HOSTED_PROVIDER_INFO[config.provider]
    this.provider = config.provider
    this.#apiKey = requiredText(config.apiKey, `${name} API key`)
    this.model = requiredText(config.model, `${name} model`)
    this.#fetch = config.fetch ?? fetch
    this.#inferenceURL = inferenceEndpointURL(
      config.inferenceURL ?? inferenceURL,
      `${name} inference URL`,
    )
    this.#idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.#teamId = config.teamId
  }

  async *streamChat(options: StreamChatOptions) {
    const { name, reasoningField } = HOSTED_PROVIDER_INFO[this.provider]
    const fireworks = this.provider === "fireworks"
    const affinity = fireworks || this.provider === "baseten"
    const response = await fetchWithIdleTimeout(
      this.#fetch,
      this.#inferenceURL,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          ...(this.#teamId ? { "x-prime-team-id": this.#teamId } : {}),
          ...(affinity && options.sessionId ? { "x-session-affinity": options.sessionId } : {}),
        },
        body: JSON.stringify(
          openaiChatCompletionRequest(this.model, options, {
            reasoningField,
            ...(this.provider === "together" && options.sessionId
              ? { promptCacheKey: options.sessionId }
              : {}),
            ...(fireworks && {
              reasoningEffort: fireworksReasoningEffort(this.model, options.minimalReasoning),
              serviceTier: fireworksServiceTier(this.model),
            }),
          }),
        ),
        signal: options.signal,
      },
      this.#idleTimeoutMs,
      name,
    )
    if (!response.ok) throw await inferenceResponseError(response, name)
    if (!response.body) throw new Error(`${name} response did not include a stream body`)
    yield* parseChatCompletionStream(response.body)
  }

  complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    return collectCompletionText(this, messages, options)
  }
}

const MAX_EFFORT_MODELS = [/^deepseek-v4(?:$|-)/, /^glm-5p2(?:$|-)/]
const HIGH_EFFORT_MODELS = [
  /^deepseek-v3p[12](?:$|-)/,
  /^glm-(?:4p5(?:-air)?|4p6|4p7|5|5p1)(?:$|-)/,
  /^minimax-m2(?:$|p\d|-)/,
  /^qwen-?3(?:$|p|-)/,
  /(?:^|-)gpt-oss-(?:20b|120b)(?:$|-)/,
]

/**
 * The highest reasoning tier Fireworks documents for a known model family, or its lowest
 * documented tier when a request should reason as little as possible. Families without a
 * documented ceiling keep the provider default either way.
 */
export function fireworksReasoningEffort(
  model: string,
  minimal = false,
): "low" | "high" | "max" | undefined {
  const resource = model.trim().split("#", 1)[0]
  const modelId = resource
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replaceAll(".", "p")
    .replaceAll("_", "-")
  if (!modelId || modelId.includes("no-thinking")) return undefined
  const highest = MAX_EFFORT_MODELS.some((pattern) => pattern.test(modelId))
    ? "max"
    : HIGH_EFFORT_MODELS.some((pattern) => pattern.test(modelId))
      ? "high"
      : undefined
  return highest && minimal ? "low" : highest
}
