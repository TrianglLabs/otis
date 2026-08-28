import { describe, expect, it } from "vitest"
import { findLocalModel } from "../../src/inference/local-catalog.js"
import { recommendedLocalModelIds } from "../../src/inference/local-recommendation.js"

const GIBIBYTE = 1024 ** 3

describe("local model recommendation", () => {
  it.each([
    [8 * GIBIBYTE, ["LiquidAI/LFM2.5-2.6B"]],
    [16 * GIBIBYTE - 1, ["LiquidAI/LFM2.5-2.6B"]],
    [16 * GIBIBYTE, ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"]],
    [24 * GIBIBYTE - 1, ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"]],
    [24 * GIBIBYTE, ["Qwen/Qwen3.8-27B"]],
    [96 * GIBIBYTE - 1, ["Qwen/Qwen3.8-27B"]],
    [96 * GIBIBYTE, ["Qwen/Qwen3.8-Flash-Next"]],
    [196 * GIBIBYTE - 1, ["Qwen/Qwen3.8-Flash-Next"]],
    [384 * GIBIBYTE, ["zai-org/GLM-5.3"]],
    [512 * GIBIBYTE, ["zai-org/GLM-5.3"]],
  ])("maps %d bytes to %j", (totalMemoryBytes, modelIds) => {
    expect(recommendedLocalModelIds(totalMemoryBytes)).toEqual(modelIds)
    expect(modelIds.every((modelId) => findLocalModel(modelId) !== undefined)).toBe(true)
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    8 * GIBIBYTE - 1,
    196 * GIBIBYTE,
    384 * GIBIBYTE - 1,
    512 * GIBIBYTE + 1,
  ])("does not recommend outside the supported tiers for %s bytes", (totalMemoryBytes) => {
    expect(recommendedLocalModelIds(totalMemoryBytes)).toEqual([])
  })
})
