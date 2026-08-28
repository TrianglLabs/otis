import { describe, expect, it } from "vitest"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import { findLocalModel, LOCAL_MODELS, localModelWeightBytes } from "../../src/inference/local-catalog.js"
import { fitLocalModel, kvCacheBytes, memoryRequiredFor } from "../../src/inference/local-fit.js"

const apple128: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 128 * 1024 ** 3,
  gpuMemoryBytes: 128 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
}

const apple16: HardwareProbe = {
  ...apple128,
  totalMemoryBytes: 16 * 1024 ** 3,
  gpuMemoryBytes: 16 * 1024 ** 3,
}

describe("local model fit", () => {
  it("gives each model its native context when memory allows", () => {
    const apple512: HardwareProbe = {
      ...apple128,
      totalMemoryBytes: 512 * 1024 ** 3,
      gpuMemoryBytes: 512 * 1024 ** 3,
    }
    for (const model of LOCAL_MODELS) {
      const fit = fitLocalModel(model, apple512)
      expect(fit.available).toBe(true)
      expect(fit.contextLength).toBe(model.nativeContextLength)
    }
  })

  it("greys out 27B-class weights on a 16 GB Mac", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const fit = fitLocalModel(qwen, apple16)
    expect(fit.available).toBe(false)
    expect(fit.memoryRequiredBytes).toBeGreaterThan(fit.memoryAvailableBytes)
  })

  it("fits gpt-oss 20B on a 16 GB Mac below native context", () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const fit = fitLocalModel(model, apple16)
    expect(fit.available).toBe(true)
    expect(fit.contextLength).toBeGreaterThanOrEqual(8_192)
    expect(fit.contextLength).toBeLessThan(model.nativeContextLength)
    expect(fit.contextLength % 1_024).toBe(0)
  })

  it("fits Gemma 4 12B at native context on a 16 GB Mac", () => {
    const gemma = findLocalModel("google/gemma-4-12B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const fit = fitLocalModel(gemma, apple16)
    expect(fit.available).toBe(true)
    expect(fit.contextLength).toBe(gemma.nativeContextLength)
  })

  it("uses the largest context that fits instead of a 32K cap", () => {
    const apple36: HardwareProbe = {
      ...apple128,
      totalMemoryBytes: 36 * 1024 ** 3,
      gpuMemoryBytes: 36 * 1024 ** 3,
    }
    const gemma = findLocalModel("google/gemma-4-31B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const fit = fitLocalModel(gemma, apple36)
    expect(fit.available).toBe(true)
    expect(fit.contextLength).toBeGreaterThan(32_768)
    expect(fit.contextLength).toBeLessThan(gemma.nativeContextLength)
    expect(fit.contextLength % 1_024).toBe(0)
    expect(fit.memoryRequiredBytes).toBeLessThanOrEqual(fit.memoryAvailableBytes)
  })

  it("scales Qwen3.8 context while preserving headroom on a 36 GB Mac", () => {
    const apple36: HardwareProbe = {
      ...apple128,
      totalMemoryBytes: 36 * 1024 ** 3,
      gpuMemoryBytes: 36 * 1024 ** 3,
    }
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")

    const fit = fitLocalModel(qwen, apple36)

    expect(fit.available).toBe(true)
    expect(fit.contextLength).toBeGreaterThan(131_072)
    expect(fit.contextLength).toBeLessThan(qwen.nativeContextLength)
    expect(apple36.totalMemoryBytes - fit.memoryRequiredBytes).toBeGreaterThanOrEqual(5.4 * 1024 ** 3)
  })

  it("counts only Qwen3.8 full-attention layers for KV", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const allLayers = 64 * 4 * 256 * 4 * 32_768
    expect(kvCacheBytes(qwen.attention, 32_768)).toBe(16 * 4 * 256 * 4 * 32_768)
    expect(kvCacheBytes(qwen.attention, 32_768)).toBeLessThan(allLayers)
  })

  it("counts only Ornith full-attention layers for KV", () => {
    const ornith = findLocalModel("ornith-ai/Ornith-1.5-9B")
    if (!ornith) throw new Error("missing catalog entry")
    const allLayers = 32 * 4 * 256 * 4 * 32_768
    expect(kvCacheBytes(ornith.attention, 32_768)).toBe(8 * 4 * 256 * 4 * 32_768)
    expect(kvCacheBytes(ornith.attention, 32_768)).toBeLessThan(allLayers)
  })

  it("counts only LFM2.5 attention layers for KV", () => {
    const lfm = findLocalModel("LiquidAI/LFM2.5-2.6B")
    if (!lfm) throw new Error("missing catalog entry")
    const allLayers = 30 * 8 * 64 * 4 * 32_768
    expect(kvCacheBytes(lfm.attention, 32_768)).toBe(8 * 8 * 64 * 4 * 32_768)
    expect(kvCacheBytes(lfm.attention, 32_768)).toBeLessThan(allLayers)
  })

  it("uses Gemma 4 global-layer geometry instead of sliding-layer heads", () => {
    const gemma = findLocalModel("google/gemma-4-31B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const naive = 60 * 16 * 256 * 4 * 32_768
    const expected = 10 * 4 * 512 * 4 * 32_768 + 50 * 16 * 256 * 4 * 1_024
    expect(kvCacheBytes(gemma.attention, 32_768)).toBe(expected)
    expect(kvCacheBytes(gemma.attention, 32_768)).toBeLessThan(naive)
    expect(memoryRequiredFor(gemma, 32_768)).toBeGreaterThan(localModelWeightBytes(gemma))
  })

  it("uses Gemma 4 12B's official global and sliding-layer geometry", () => {
    const gemma = findLocalModel("google/gemma-4-12B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const expected = 8 * 1 * 512 * 4 * 32_768 + 40 * 8 * 256 * 4 * 1_024
    expect(kvCacheBytes(gemma.attention, 32_768)).toBe(expected)
  })

  it("fits the selected large-model quants at the start of their recommendation tiers", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    const glm = findLocalModel("zai-org/GLM-5.3")
    if (!qwen || !glm) throw new Error("missing large catalog entry")

    expect(fitLocalModel(qwen, { ...apple128, totalMemoryBytes: 96 * 1024 ** 3 }).available).toBe(true)
    expect(fitLocalModel(glm, { ...apple128, totalMemoryBytes: 384 * 1024 ** 3 }).available).toBe(true)
  })

  it("uses the full-attention and MLA cache geometries for the new models", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    const glm = findLocalModel("zai-org/GLM-5.3")
    if (!qwen || !glm) throw new Error("missing large catalog entry")

    expect(kvCacheBytes(qwen.attention, 8_192)).toBe(12 * 2 * 256 * 4 * 8_192)
    expect(kvCacheBytes(glm.attention, 8_192)).toBe(78 * (512 + 64) * 2 * 8_192)
  })

  it("grows gpt-oss KV on the dense attention layers", () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const atWindow = kvCacheBytes(model.attention, 128)
    const atNative = kvCacheBytes(model.attention, model.nativeContextLength)
    expect(atNative).toBeGreaterThan(atWindow)
    expect(atNative).toBe(12 * 8 * 64 * 4 * 131_072 + 12 * 8 * 64 * 4 * 128)
  })
})
