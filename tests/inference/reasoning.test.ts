import { describe, expect, it } from "vitest"
import { highestReasoningEffort } from "../../src/inference/reasoning.js"

describe("highestReasoningEffort", () => {
  it.each([
    ["accounts/fireworks/models/deepseek-v4", "max"],
    ["accounts/fireworks/models/glm-5p2", "max"],
    ["accounts/fireworks/models/gpt-oss-120b", "high"],
    ["accounts/fireworks/models/minimax-m2p5", "high"],
    ["accounts/fireworks/models/qwen3-235b-a22b", "high"],
    ["accounts/fireworks/models/deepseek-v3p2", "high"],
    ["accounts/fireworks/models/glm-5p1", "high"],
    ["accounts/fireworks/models/glm-4.5-air", "high"],
    ["accounts/fireworks/routers/glm-5p2-fast", "max"],
  ] as const)("uses the highest supported tier for %s", (model, expected) => {
    expect(highestReasoningEffort(model)).toBe(expected)
  })

  it.each([
    "accounts/fireworks/models/kimi-k2-thinking",
    "accounts/fireworks/models/llama-v3p1-70b-instruct",
    "accounts/fireworks/models/qwen3-no-thinking",
    "accounts/fireworks/models/tool-model",
  ])("uses the provider default when %s has no documented effort ceiling", (model) => {
    expect(highestReasoningEffort(model)).toBeUndefined()
  })
})
