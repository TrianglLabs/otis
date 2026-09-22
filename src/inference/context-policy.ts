import type { ModelProvider } from "./types.js"

export const LOCAL_MIN_CONTEXT_LENGTH = 65_536

export function compactionContextLength(model: {
  provider?: ModelProvider
  contextLength?: number
}) {
  if (model.provider === "omlx") return model.contextLength ?? LOCAL_MIN_CONTEXT_LENGTH
  // Direct servers and PAIR expose the same inventory API, without a reliable serving limit.
  // The minimum is a product requirement and fallback budget, not a verified server allocation.
  // Architecture metadata and one routed node's allocation never become cluster compaction state.
  return model.provider === "pair" ? LOCAL_MIN_CONTEXT_LENGTH : model.contextLength
}

/** Whether an overflow error's reported limit is the serving window rather than one node's. */
export function reportedContextLengthIsServing(provider: ModelProvider) {
  return provider !== "pair"
}

const LOCAL_CONTEXT_REQUIREMENT =
  `Otis requires at least ${LOCAL_MIN_CONTEXT_LENGTH.toLocaleString("en-US")} tokens (64K) for local agent use. ` +
  "Increase the model's context in the server and reconnect. For NVIDIA PAIR, configure every eligible node."

/**
 * Validate reported serving limits; an unknown limit remains unverified, never inferred from
 * architecture.
 */
export function requireLocalContextLength(contextLength: number | undefined, server: string) {
  if (contextLength === undefined || contextLength >= LOCAL_MIN_CONTEXT_LENGTH) return
  throw new Error(
    `${server} reports a context limit of ${contextLength.toLocaleString("en-US")} tokens. ` +
      LOCAL_CONTEXT_REQUIREMENT,
  )
}

/**
 * A rejected input that is already well inside the policy budget, with no limit reported, means
 * the server's window is smaller than local agent use supports; compaction cannot fix that.
 */
export function unreportedContextLimitError(inputTokens: number) {
  return new Error(
    `The model server rejected a request of about ${inputTokens.toLocaleString("en-US")} tokens ` +
      `without reporting its context limit. ${LOCAL_CONTEXT_REQUIREMENT}`,
  )
}
