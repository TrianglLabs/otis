export type ReasoningEffort = "high" | "max"

const MAX_EFFORT_MODELS = [/^deepseek-v4(?:$|-)/, /^glm-5p2(?:$|-)/]
const HIGH_EFFORT_MODELS = [
  /^deepseek-v3p[12](?:$|-)/,
  /^glm-(?:4p5(?:-air)?|4p6|4p7|5|5p1)(?:$|-)/,
  /^minimax-m2(?:$|p\d|-)/,
  /^qwen-?3(?:$|p|-)/,
  /(?:^|-)gpt-oss-(?:20b|120b)(?:$|-)/,
]

/** Returns the highest reasoning tier Fireworks documents for a known model family. */
export function highestReasoningEffort(model: string): ReasoningEffort | undefined {
  const modelId = normalizedModelId(model)
  if (!modelId || modelId.includes("no-thinking")) return undefined
  if (MAX_EFFORT_MODELS.some((pattern) => pattern.test(modelId))) return "max"
  if (HIGH_EFFORT_MODELS.some((pattern) => pattern.test(modelId))) return "high"
  return undefined
}

function normalizedModelId(model: string) {
  const resource = model.trim().split("#", 1)[0]
  return resource.split("/").at(-1)?.toLowerCase().replaceAll(".", "p").replaceAll("_", "-")
}
