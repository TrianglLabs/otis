import { describe, expect, it } from "vitest"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import {
  findLocalModel,
  LOCAL_MODELS,
  type LocalModelSpec,
  localModelWeightBytes,
} from "../../src/inference/local-catalog.js"
import { fitLocalModel, memoryRequiredFor } from "../../src/inference/local-fit.js"

const apple128: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 128 * 1024 ** 3,
  gpuMemoryBytes: 96 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
  gpuCount: 1,
}

const apple16: HardwareProbe = {
  ...apple128,
  totalMemoryBytes: 16 * 1024 ** 3,
  gpuMemoryBytes: Math.floor((16 * 1024 ** 3 * 2) / 3),
}

const linux32: HardwareProbe = {
  platform: "linux",
  arch: "x64",
  backend: "vulkan",
  unifiedMemory: false,
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: 32 * 1024 ** 3,
  gpuCount: 1,
}

describe("local model fit", () => {
  it("sizes dedicated-GPU context after weights, cache, buffers, and device headroom", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const fit = fitLocalModel(qwen, linux32)
    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(false)
    expect(fit.memoryAvailableBytes).toBe(31 * 1024 ** 3)
    expect(fit.contextLength).toBe(193_536)
    // Qwen: 16 full-attention layers, 4 KV heads, 256 dimensions, f16 K+V.
    const footprint =
      localModelWeightBytes(qwen) + 16 * 4 * 256 * 4 * fit.contextLength + 1.5 * 1024 ** 3
    expect(fit.memoryRequiredBytes).toBe(footprint)
    expect(footprint).toBeLessThanOrEqual(fit.memoryAvailableBytes)
    expect(footprint + 16 * 4 * 256 * 4 * 1_024).toBeGreaterThan(fit.memoryAvailableBytes)
    // Bonsai 2 shares Qwen3.8's KV geometry.
    const bonsai = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!bonsai) throw new Error("missing catalog entry")
    expect(kvCacheBytes(bonsai, fit.contextLength)).toBe(16 * 4 * 256 * 4 * fit.contextLength)
  })

  it("keeps a weights-only fit selectable with CPU offload at 64K", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const hardware = { ...linux32, gpuMemoryBytes: 24 * 1024 ** 3 }
    expect(localModelWeightBytes(qwen)).toBeLessThan(23 * 1024 ** 3)
    const fit = fitLocalModel(qwen, hardware)
    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(true)
    expect(fit.contextLength).toBe(65_536)
    expect(fit.memoryRequiredBytes).toBeGreaterThan(23 * 1024 ** 3)
    expect(fit.memoryRequiredBytes).toBeLessThan(fit.memoryAvailableBytes)
  })

  it("holds a GPU-resident model without host RAM for its layers", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const fit = fitLocalModel(qwen, { ...linux32, totalMemoryBytes: 16 * 1024 ** 3 })
    expect(fit).toMatchObject({
      available: true,
      requiresCpuOffload: false,
      contextLength: 193_536,
      memoryAvailableBytes: 31 * 1024 ** 3,
    })
  })

  it("keeps the 27B and 31B models selectable on 16 GB RAM with a 24 GB card", () => {
    const hardware = {
      ...linux32,
      totalMemoryBytes: 16 * 1024 ** 3,
      gpuMemoryBytes: 24 * 1024 ** 3,
    }
    for (const id of ["Qwen/Qwen3.8-27B", "google/gemma-4-31B-it"]) {
      const model = findLocalModel(id)
      if (!model) throw new Error("missing catalog entry")
      const fit = fitLocalModel(model, hardware)
      // Only the layers that spill past the 23 GiB GPU budget need the 14 GiB host pool.
      expect(fit).toMatchObject({
        available: true,
        requiresCpuOffload: true,
        contextLength: 65_536,
        memoryAvailableBytes: 37 * 1024 ** 3,
      })
      expect(fit.memoryRequiredBytes).toBeGreaterThan(23 * 1024 ** 3)
    }
    // GPU plus host still has to hold the minimum footprint.
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const small = { ...hardware, totalMemoryBytes: 8 * 1024 ** 3, gpuMemoryBytes: 8 * 1024 ** 3 }
    expect(fitLocalModel(qwen, small)).toMatchObject({
      available: false,
      requiresCpuOffload: false,
      memoryAvailableBytes: 13 * 1024 ** 3,
    })
  })

  it.each(["cpu", "unknown GPU"])("uses the full host budget with %s inference", (mode) => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const hardware: HardwareProbe =
      mode === "cpu" ? { ...linux32, backend: "cpu" } : { ...linux32, gpuMemoryBytes: undefined }
    const fit = fitLocalModel(qwen, hardware)
    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(false)
    expect(fit.contextLength).toBe(qwen.nativeContextLength)
  })

  it("gives each model its native context when memory allows", () => {
    const apple1024 = appleHardware(1024)
    for (const model of LOCAL_MODELS) {
      const fit = fitLocalModel(model, apple1024)
      expect(fit.available).toBe(true)
      expect(fit.contextLength).toBe(model.nativeContextLength)
    }
  })

  it("hides Qwen3.8 on a 24 GB Mac when it cannot sustain 64K context", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    const fit = fitLocalModel(qwen, appleHardware(24))
    expect(fit.available).toBe(false)
    expect(fit.contextLength).toBe(65_536)
    expect(fit.memoryRequiredBytes).toBeGreaterThan(fit.memoryAvailableBytes)
  })

  it("hides gpt-oss 20B on a 16 GB Mac when it cannot sustain 64K context", () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const fit = fitLocalModel(model, apple16)
    expect(fit.available).toBe(false)
    expect(fit.contextLength).toBe(65_536)
    expect(fit.memoryRequiredBytes).toBeGreaterThan(fit.memoryAvailableBytes)
  })

  it("sizes Gemma 4 12B inside the Metal working set of a 16 GB Mac", () => {
    const gemma = findLocalModel("google/gemma-4-12B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const fit = fitLocalModel(gemma, apple16)
    // Two thirds of 16 GiB, less llama.cpp's 1 GiB margin, not RAM less 15%.
    expect(fit.memoryAvailableBytes).toBe(Math.floor((16 * 1024 ** 3 * 2) / 3) - 1024 ** 3)
    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(false)
    expect(fit.contextLength).toBeGreaterThanOrEqual(65_536)
    expect(fit.contextLength).toBeLessThan(gemma.nativeContextLength)
    expect(fit.memoryRequiredBytes).toBeLessThanOrEqual(fit.memoryAvailableBytes)
  })

  it("keeps Bonsai 2 selectable with CPU offload on a 16 GB Mac", () => {
    const bonsai = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!bonsai) throw new Error("missing catalog entry")
    const fit = fitLocalModel(bonsai, apple16)
    expect(fit.model.quant).toBe("PTQ1_0")
    // 64K of Qwen3-geometry KV cache does not fit the GPU working set beside the weights.
    expect(fit).toMatchObject({
      available: true,
      requiresCpuOffload: true,
      contextLength: 65_536,
      memoryAvailableBytes: 13 * 1024 ** 3,
    })
  })

  it("prefers Bonsai PQ2_0 above the compact-memory tier", () => {
    const bonsai = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!bonsai) throw new Error("missing catalog entry")
    const apple24 = { ...apple16, totalMemoryBytes: 24 * 1024 ** 3, gpuMemoryBytes: 24 * 1024 ** 3 }
    expect(fitLocalModel(bonsai, apple24).model.quant).toBe("PQ2_0")

    const linux = {
      ...apple128,
      platform: "linux" as const,
      backend: "vulkan" as const,
      unifiedMemory: false,
    }
    expect(fitLocalModel(bonsai, { ...linux, gpuMemoryBytes: 8 * 1024 ** 3 }).model.quant).toBe(
      "PTQ1_0",
    )
    expect(fitLocalModel(bonsai, { ...linux, gpuMemoryBytes: 16 * 1024 ** 3 }).model.quant).toBe(
      "PTQ1_0",
    )
    expect(fitLocalModel(bonsai, { ...linux, gpuMemoryBytes: 24 * 1024 ** 3 }).model.quant).toBe(
      "PTQ1_0",
    )
    expect(fitLocalModel(bonsai, { ...linux, backend: "cpu" }).model.quant).toBe("PQ2_0")
  })

  it.each([
    ["A100", [8.0], 80, "PQ2_0"],
    ["H100", [9.0], 80, "PQ2_0"],
    ["RTX 5090", [12.0], 32, "PQ2_0"],
    ["RTX 4090", [8.9], 24, "PTQ1_0"],
    ["L4", [8.9], 24, "PTQ1_0"],
    ["multiple Ada GPUs", [8.9, 8.9], 48, "PTQ1_0"],
    ["mixed architectures", [8.9, 12.0], 56, "PQ2_0"],
    ["unknown architecture", undefined, 24, "PQ2_0"],
    ["empty architecture list", [], 24, "PQ2_0"],
    ["compact Blackwell", [12.0], 8, "PTQ1_0"],
  ] as const)("selects Bonsai packing for %s", (_name, capabilities, vram, quant) => {
    const bonsai = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    if (!bonsai) throw new Error("missing catalog entry")
    const cuda: HardwareProbe = {
      ...apple128,
      platform: "linux",
      arch: "x64",
      backend: "cuda",
      cudaVersion: "13.3",
      unifiedMemory: false,
      gpuMemoryBytes: vram * 1024 ** 3,
      gpuCount: capabilities?.length || 1,
      cudaComputeCapabilities: capabilities,
    }
    const fit = fitLocalModel(bonsai, cuda)
    expect(fit.available).toBe(true)
    expect(fit.model.quant).toBe(quant)
    expect(fit.memoryRequiredBytes).toBe(memoryRequiredFor(fit.model, fit.contextLength))
    // The actual Prism backend on ARM Linux is Vulkan, which requires PTQ1.
    expect(fitLocalModel(bonsai, { ...cuda, arch: "arm64" }).model.quant).toBe("PTQ1_0")
    expect(fitLocalModel(fit.model, { ...cuda, backend: "vulkan" }).model.quant).toBe("PTQ1_0")
  })

  it("uses the largest context that fits instead of a 32K cap", () => {
    const gemma = findLocalModel("google/gemma-4-31B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const fit = fitLocalModel(gemma, appleHardware(48))
    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(false)
    expect(fit.contextLength).toBeGreaterThan(32_768)
    expect(fit.contextLength).toBeLessThan(gemma.nativeContextLength)
    expect(fit.contextLength % 1_024).toBe(0)
    expect(fit.memoryRequiredBytes).toBeLessThanOrEqual(fit.memoryAvailableBytes)
  })

  it("scales Qwen3.8 context inside the working set of a 48 GB Mac", () => {
    const apple48 = appleHardware(48)
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")

    const fit = fitLocalModel(qwen, apple48)

    expect(fit.available).toBe(true)
    expect(fit.requiresCpuOffload).toBe(false)
    expect(fit.memoryAvailableBytes).toBe(35 * 1024 ** 3)
    expect(fit.contextLength).toBeGreaterThan(131_072)
    expect(fit.contextLength).toBeLessThan(qwen.nativeContextLength)
    expect(apple48.totalMemoryBytes - fit.memoryRequiredBytes).toBeGreaterThanOrEqual(
      13 * 1024 ** 3,
    )
  })

  it("keeps Qwen3.8 27B off the GPU of 32 and 36 GB Macs by its 64K cache alone", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-27B")
    if (!qwen) throw new Error("missing catalog entry")
    for (const ramGiB of [32, 36]) {
      const fit = fitLocalModel(qwen, appleHardware(ramGiB))
      expect(fit).toMatchObject({
        available: true,
        requiresCpuOffload: true,
        contextLength: 65_536,
      })
      expect(memoryRequiredFor(qwen, 65_536)).toBeGreaterThan(
        Math.floor((ramGiB * 1024 ** 3 * 2) / 3) - 1024 ** 3,
      )
    }
  })

  it("counts only Ornith full-attention layers for KV", () => {
    const ornith = findLocalModel("ornith-ai/Ornith-1.5-9B")
    if (!ornith) throw new Error("missing catalog entry")
    const allLayers = 32 * 4 * 256 * 4 * 32_768
    expect(kvCacheBytes(ornith, 32_768)).toBe(8 * 4 * 256 * 4 * 32_768)
    expect(kvCacheBytes(ornith, 32_768)).toBeLessThan(allLayers)
  })

  it("counts only LFM2.5 attention layers for KV", () => {
    const lfm = findLocalModel("LiquidAI/LFM2.5-2.6B")
    if (!lfm) throw new Error("missing catalog entry")
    const allLayers = 30 * 8 * 64 * 4 * 32_768
    expect(kvCacheBytes(lfm, 32_768)).toBe(8 * 8 * 64 * 4 * 32_768)
    expect(kvCacheBytes(lfm, 32_768)).toBeLessThan(allLayers)
  })

  it("uses Gemma 4 global-layer geometry instead of sliding-layer heads", () => {
    const gemma = findLocalModel("google/gemma-4-31B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const naive = 60 * 16 * 256 * 4 * 32_768
    const expected = 10 * 4 * 512 * 4 * 32_768 + 50 * 16 * 256 * 4 * 1_024
    expect(kvCacheBytes(gemma, 32_768)).toBe(expected)
    expect(kvCacheBytes(gemma, 32_768)).toBeLessThan(naive)
    expect(memoryRequiredFor(gemma, 32_768)).toBeGreaterThan(localModelWeightBytes(gemma))
  })

  it("uses Gemma 4 12B's official global and sliding-layer geometry", () => {
    const gemma = findLocalModel("google/gemma-4-12B-it")
    if (!gemma) throw new Error("missing catalog entry")
    const expected = 8 * 1 * 512 * 4 * 32_768 + 40 * 8 * 256 * 4 * 1_024
    expect(kvCacheBytes(gemma, 32_768)).toBe(expected)
  })

  it("fits the selected large-model quants at the start of their recommendation tiers", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    const glm = findLocalModel("zai-org/GLM-5.3")
    if (!qwen || !glm) throw new Error("missing large catalog entry")

    expect(fitLocalModel(qwen, appleHardware(128))).toMatchObject({
      available: true,
      requiresCpuOffload: false,
    })
    expect(fitLocalModel(glm, appleHardware(512))).toMatchObject({
      available: true,
      requiresCpuOffload: false,
    })
    // One tier down, the weights still load with layers on the CPU.
    expect(fitLocalModel(qwen, appleHardware(96))).toMatchObject({
      available: true,
      requiresCpuOffload: true,
    })
    expect(fitLocalModel(glm, appleHardware(384))).toMatchObject({
      available: true,
      requiresCpuOffload: true,
    })
  })

  it("uses the full-attention and MLA cache geometries for the new models", () => {
    const qwen = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    const glm = findLocalModel("zai-org/GLM-5.3")
    if (!qwen || !glm) throw new Error("missing large catalog entry")

    expect(kvCacheBytes(qwen, 8_192)).toBe(12 * 2 * 256 * 4 * 8_192)
    expect(kvCacheBytes(glm, 8_192)).toBe(78 * (512 + 64) * 2 * 8_192)
  })

  it("grows gpt-oss KV on the dense attention layers", () => {
    const model = findLocalModel("openai/gpt-oss-20b")
    if (!model) throw new Error("missing catalog entry")
    const atWindow = kvCacheBytes(model, 128)
    const atNative = kvCacheBytes(model, model.nativeContextLength)
    expect(atNative).toBeGreaterThan(atWindow)
    expect(atNative).toBe(12 * 8 * 64 * 4 * 131_072 + 12 * 8 * 64 * 4 * 128)
  })
})

/** A Mac with the default Metal working set: two thirds of RAM up to 36 GiB, three quarters above. */
function appleHardware(ramGiB: number): HardwareProbe {
  const totalMemoryBytes = ramGiB * 1024 ** 3
  return {
    ...apple128,
    totalMemoryBytes,
    gpuMemoryBytes: Math.floor(
      (totalMemoryBytes * (ramGiB <= 36 ? 2 : 3)) / (ramGiB <= 36 ? 3 : 4),
    ),
  }
}

/** Context-dependent memory only: the KV cache without weights and fixed runtime buffers. */
function kvCacheBytes(model: LocalModelSpec, contextLength: number) {
  return memoryRequiredFor(model, contextLength) - memoryRequiredFor(model, 0)
}
