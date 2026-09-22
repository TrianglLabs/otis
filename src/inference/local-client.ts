import { type LocalThinkingLevel, localThinkingParameters } from "./local-thinking.js"
import { OpenAICompatibleClient } from "./openai-compat.js"
import type { LocalClientConfig, StreamChatOptions } from "./types.js"

export class LlamaCppClient extends OpenAICompatibleClient {
  readonly #thinkingLevel: (() => LocalThinkingLevel | undefined) | undefined

  constructor(
    config: LocalClientConfig & { thinkingLevel?: () => LocalThinkingLevel | undefined },
  ) {
    super({
      ...config,
      modelLabel: "Local model",
      inferenceURLLabel: "Local inference URL",
      requestLabel: "Local model",
    })
    this.#thinkingLevel = config.thinkingLevel
  }

  protected override requestBody(options: StreamChatOptions) {
    return {
      ...super.requestBody(options),
      ...localThinkingParameters(this.model, this.#thinkingLevel?.()),
    }
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
