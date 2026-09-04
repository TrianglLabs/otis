import type { ModelProvider } from "./types.js"

/** Internal PAIR compaction guard; never presented as reported model metadata. */
const PAIR_UNKNOWN_CONTEXT_LENGTH = 65_536

export function compactionContextLength(model: { provider?: ModelProvider; contextLength?: number }) {
  return model.provider === "pair" ? PAIR_UNKNOWN_CONTEXT_LENGTH : model.contextLength
}
