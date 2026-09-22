import {
  type LocalThinkingLevel,
  localThinkingParameters,
  minimalLocalThinkingLevel,
} from "./local-thinking.js"
import { OpenAICompatibleClient } from "./openai-compat.js"
import type { LocalClientConfig, StreamChatOptions } from "./types.js"

type LlamaCppClientConfig = LocalClientConfig & {
  thinkingLevel?: () => LocalThinkingLevel | undefined
  /** Throws when the managed server died since it was ready, instead of a bare fetch failure. */
  assertServing?: () => void
}

export class LlamaCppClient extends OpenAICompatibleClient {
  readonly #thinkingLevel: LlamaCppClientConfig["thinkingLevel"]
  readonly #assertServing: LlamaCppClientConfig["assertServing"]

  constructor(config: LlamaCppClientConfig) {
    super({
      ...config,
      modelLabel: "Local model",
      inferenceURLLabel: "Local inference URL",
      requestLabel: "Local model",
    })
    this.#thinkingLevel = config.thinkingLevel
    this.#assertServing = config.assertServing
  }

  protected override request(options: StreamChatOptions, suffix?: string) {
    this.#assertServing?.()
    return super.request(options, suffix)
  }

  protected override requestBody(options: StreamChatOptions) {
    // Internal requests such as compaction can ask for the least reasoning the template allows,
    // overriding the saved effort for that request only.
    const level = options.minimalReasoning
      ? minimalLocalThinkingLevel(this.model)
      : this.#thinkingLevel?.()
    return { ...super.requestBody(options), ...localThinkingParameters(this.model, level) }
  }

  async countTokens(options: StreamChatOptions): Promise<number> {
    // Both pinned runtimes count through the same template and tokenizer as inference,
    // including tool schemas, special tokens, reasoning history, and multimodal input.
    const response = await this.request(options, "/input_tokens")
    const count = ((await response.json()) as { input_tokens?: unknown } | null)?.input_tokens
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error("Local model server returned an invalid input token count.")
    }
    return Number(count)
  }
}
