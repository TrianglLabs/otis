import { OpenAICompatibleClient } from "./openai-compatible-client.js"
import type { LocalClientConfig } from "./types.js"

export class LlamaCppClient extends OpenAICompatibleClient {
  constructor(config: LocalClientConfig) {
    super({
      ...config,
      modelLabel: "Local model",
      inferenceURLLabel: "Local inference URL",
      requestLabel: "Local model",
    })
  }
}
