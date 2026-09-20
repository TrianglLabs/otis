import { type LocalThinkingLevel, localThinkingParameters } from "./local-thinking.js"
import { OpenAICompatibleClient } from "./openai-compatible-client.js"
import type { LocalClientConfig, StreamChatOptions } from "./types.js"

export class LlamaCppClient extends OpenAICompatibleClient {
  readonly #thinkingLevel: (() => LocalThinkingLevel | undefined) | undefined

  protected override requestBody(options: StreamChatOptions) {
    return { ...super.requestBody(options), ...localThinkingParameters(this.model, this.#thinkingLevel?.()) }
  }

  async countTokens(options: StreamChatOptions): Promise<number> {
    // Both pinned runtimes count through the same template and tokenizer as inference,
    // including tool schemas, special tokens, reasoning history, and multimodal input.
    const response = await this.request(options, "/input_tokens")
    const body = (await response.json()) as { input_tokens?: unknown } | null
    if (!Number.isSafeInteger(body?.input_tokens) || Number(body?.input_tokens) < 0) {
      throw new Error("Local model server returned an invalid input token count.")
    }
    return Number(body?.input_tokens)
  }

  constructor(config: LocalClientConfig & { thinkingLevel?: () => LocalThinkingLevel | undefined }) {
    super({
      ...config,
      modelLabel: "Local model",
      inferenceURLLabel: "Local inference URL",
      requestLabel: "Local model",
    })
    this.#thinkingLevel = config.thinkingLevel
  }
}
