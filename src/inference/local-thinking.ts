const LOCAL_THINKING_LEVELS = ["off", "on", "low", "medium", "high", "xhigh", "max"] as const
export type LocalThinkingLevel = (typeof LOCAL_THINKING_LEVELS)[number]
export type LocalThinkingSelection = LocalThinkingLevel | "default"
export type LocalThinkingPreferences = Record<string, LocalThinkingLevel>

type ThinkingCapability = {
  levels: readonly LocalThinkingLevel[]
  defaultLevel: LocalThinkingLevel
}

// Model-native template controls only; never invent token budgets or unsupported effort tiers.
// Qwen: https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/chat_template.jinja
// Bonsai: https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf#best-practices
// Other entries follow the authors' chat_template.jinja files for the named checkpoints.
// Gemma templates default thinking off, but our pinned llama-server enables it by default.
// defaultLevel reflects the managed server's behavior when no request override is sent.
const CAPABILITIES: Record<string, ThinkingCapability> = {
  "Qwen/Qwen3.8-27B": { levels: ["off", "low", "medium", "xhigh"], defaultLevel: "xhigh" },
  "Qwen/Qwen3.8-Flash-Next": { levels: ["off", "low", "medium", "xhigh"], defaultLevel: "xhigh" },
  "prism-ml/Ternary-Bonsai-2-27B-gguf": {
    levels: ["off", "medium", "xhigh"],
    defaultLevel: "xhigh",
  },
  "openai/gpt-oss-20b": { levels: ["low", "medium", "high"], defaultLevel: "medium" },
  "zai-org/GLM-5.3": { levels: ["low", "high", "max"], defaultLevel: "max" },
  "ornith-ai/Ornith-1.5-9B": { levels: ["off", "on"], defaultLevel: "on" },
  "google/gemma-4-12B-it": { levels: ["off", "on"], defaultLevel: "on" },
  "google/gemma-4-26B-A4B-it": { levels: ["off", "on"], defaultLevel: "on" },
  "google/gemma-4-31B-it": { levels: ["off", "on"], defaultLevel: "on" },
}

export function localThinkingCapability(model: string): ThinkingCapability | undefined {
  return Object.hasOwn(CAPABILITIES, model) ? CAPABILITIES[model] : undefined
}

export function validateLocalThinkingSelection(
  model: string,
  level: string,
): asserts level is LocalThinkingSelection {
  const capability = localThinkingCapability(model)
  if (
    !capability ||
    (level !== "default" && !capability.levels.includes(level as LocalThinkingLevel))
  ) {
    throw new Error("This model does not support that thinking effort.")
  }
}

/** The least reasoning the model's template controls allow: "off" when listed, else the lowest. */
export function minimalLocalThinkingLevel(model: string): LocalThinkingLevel | undefined {
  const levels = localThinkingCapability(model)?.levels
  if (!levels) return undefined
  const rank = (level: LocalThinkingLevel) => LOCAL_THINKING_LEVELS.indexOf(level)
  return [...levels].sort((a, b) => rank(a) - rank(b))[0]
}

export function localThinkingParameters(model: string, level: LocalThinkingLevel | undefined) {
  if (!level || !localThinkingCapability(model)?.levels.includes(level)) return {}
  if (level === "off" || level === "on")
    return { chat_template_kwargs: { enable_thinking: level === "on" } }
  return { reasoning_effort: level }
}

export type LocalThinkingState = ThinkingCapability & {
  modelId: string
  selected: LocalThinkingSelection
}
