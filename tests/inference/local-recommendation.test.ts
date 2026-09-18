import { describe, expect, it } from "vitest"
import { detectHardware, type HardwareProbe, inferenceMemoryBudget } from "../../src/inference/hardware.js"
import { findLocalModel, localModelWeightBytes } from "../../src/inference/local-catalog.js"
import { fitLocalModel, memoryRequiredFor } from "../../src/inference/local-fit.js"
import { recommendedLocalModelIds } from "../../src/inference/local-recommendation.js"

const GIBIBYTE = 1024 ** 3
const LFM = "LiquidAI/LFM2.5-2.6B"
const BONSAI = "prism-ml/Ternary-Bonsai-2-27B-gguf"
const QWEN = "Qwen/Qwen3.8-27B"
const FLASH = "Qwen/Qwen3.8-Flash-Next"
const GLM = "zai-org/GLM-5.3"
const ORNITH = "ornith-ai/Ornith-1.5-9B"
const GEMMA = "google/gemma-4-12B-it"

describe("local model recommendation", () => {
  it.each([
    [8, [LFM]],
    [12, [ORNITH]],
    [16, [BONSAI]],
    [24, [BONSAI]],
    [32, [QWEN]],
    [64, [QWEN]],
    [96, [FLASH]],
    [196, [FLASH]],
    [256, [FLASH]],
    [384, [GLM]],
    [512, [GLM]],
    [1024, [GLM]],
  ])("recommends fitting models with %d GiB unified memory", (memoryGiB, ids) => {
    expect(recommendedLocalModelIds(appleHardware(memoryGiB))).toEqual(ids)
  })

  it.each([
    [4, LFM],
    [6, LFM],
    [8, BONSAI],
    [12, BONSAI],
    [16, BONSAI],
    [20, QWEN],
    [24, QWEN],
    [32, QWEN],
    [48, QWEN],
    [64, QWEN],
    [80, FLASH],
    [96, FLASH],
    [192, FLASH],
    [256, FLASH],
    [384, GLM],
    [1024, GLM],
  ])("uses %d GiB dedicated VRAM rather than large host RAM to choose %s", (gpuGiB, id) => {
    expect(recommendedLocalModelIds(linuxHardware(1024, gpuGiB))).toEqual([id])
  })

  it.each([32, 64, 128, 256, 1024])("keeps the 24 GiB GPU recommendation stable with %d GiB host RAM", (ramGiB) => {
    expect(recommendedLocalModelIds(linuxHardware(ramGiB, 24))).toEqual([QWEN])
  })

  it.each([
    [8, LFM],
    [16, BONSAI],
    [32, QWEN],
  ])("falls back when %d GiB host RAM cannot fit a larger GPU candidate", (ramGiB, id) => {
    expect(recommendedLocalModelIds(linuxHardware(ramGiB, 96))).toEqual([id])
  })

  it.each([8188, 8191, 8192, 12288, 16380])("handles %d MiB reported VRAM without rounded tiers", (gpuMiB) => {
    expect(recommendedLocalModelIds({ ...linuxHardware(15.8, 8), gpuMemoryBytes: gpuMiB * 1024 ** 2 })).toEqual([
      BONSAI,
    ])
  })

  it("uses exact artifact size and device headroom at the VRAM boundary", () => {
    const hardware = linuxHardware(64, 24)
    const model = findLocalModel(QWEN)
    if (!model) throw new Error("missing Qwen catalog entry")
    const boundary = localModelWeightBytes(model) + inferenceMemoryBudget(hardware).deviceHeadroomBytes
    expect(recommendedLocalModelIds({ ...hardware, gpuMemoryBytes: boundary })).toEqual([QWEN])
    expect(recommendedLocalModelIds({ ...hardware, gpuMemoryBytes: boundary - 1 })).toEqual([BONSAI])
  })

  it("accounts for each GPU's margin before recommending a larger model", async () => {
    const probe = async (nvidiaOutput: string) =>
      detectHardware({
        env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * GIBIBYTE },
        nvidiaSmi: async () => nvidiaOutput,
      })
    // Equal combined VRAM, but two devices need 2 GiB rather than 1 GiB of headroom.
    const single = await probe("19456\n")
    const dual = await probe("9728\n9728\n")
    expect(single.gpuMemoryBytes).toBe(dual.gpuMemoryBytes)
    expect(recommendedLocalModelIds(single)).toEqual([QWEN])
    expect(recommendedLocalModelIds(dual)).toEqual([BONSAI])
  })

  it("falls back at the exact host-fit boundary without rounding memory upward", () => {
    const hardware = appleHardware(16)
    const model = findLocalModel(BONSAI)
    if (!model) throw new Error("missing Bonsai catalog entry")
    const selected = fitLocalModel(model, hardware).model
    // These Macs reserve 3 GiB; the selected PTQ1 packing remains the same below 16 GiB.
    const totalMemoryBytes = memoryRequiredFor(selected, 65_536) + 3 * GIBIBYTE
    expect(recommendedLocalModelIds({ ...hardware, totalMemoryBytes })).toEqual([BONSAI])
    const fallback = recommendedLocalModelIds({ ...hardware, totalMemoryBytes: totalMemoryBytes - 1 })
    expect(fallback).not.toContain(BONSAI)
    expect(fallback.length).toBeGreaterThan(0)
  })

  it.each([
    [8, [LFM]],
    [12, [ORNITH, GEMMA]],
    [16, [BONSAI]],
    [32, [QWEN]],
    [256, [FLASH]],
    [1024, [GLM]],
  ])("uses host fit for CPU-only systems with %d GiB RAM", (ramGiB, ids) => {
    // Stale GPU metadata must not constrain CPU recommendations.
    expect(recommendedLocalModelIds({ ...linuxHardware(ramGiB, 1), backend: "cpu" })).toEqual(ids)
  })

  it("uses host fit when a Vulkan device does not report VRAM", () => {
    const hardware = linuxHardware(32)
    expect(recommendedLocalModelIds(hardware)).toEqual([QWEN])
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    4 * GIBIBYTE,
  ])("does not recommend with invalid or insufficient host memory: %s", (totalMemoryBytes) => {
    expect(recommendedLocalModelIds({ ...appleHardware(16), totalMemoryBytes })).toEqual([])
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    GIBIBYTE,
  ])("does not treat invalid or insufficient VRAM as unlimited: %s", (gpuMemoryBytes) => {
    expect(recommendedLocalModelIds({ ...linuxHardware(64, 24), gpuMemoryBytes })).toEqual([])
  })

  it("does not recommend local models on an unsupported runtime target", () => {
    expect(recommendedLocalModelIds({ ...linuxHardware(64), platform: "win32" })).toEqual([])
    expect(recommendedLocalModelIds({ ...linuxHardware(64), arch: "ia32" })).toEqual([])
  })

  it("never recommends a model outside host fit or the known dedicated weight budget", () => {
    for (const ramGiB of [8, 12, 16, 24, 32, 64, 96, 196, 256, 384, 1024]) {
      for (const gpuGiB of [4, 8, 16, 24, 48, 80, 96, 384]) {
        const hardware = linuxHardware(ramGiB, gpuGiB)
        const ids = recommendedLocalModelIds(hardware)
        expect(ids.length).toBeGreaterThan(0)
        for (const id of ids) {
          const model = findLocalModel(id)
          if (!model) throw new Error(`missing catalog entry: ${id}`)
          const fit = fitLocalModel(model, hardware)
          expect(fit.available).toBe(true)
          expect(localModelWeightBytes(fit.model)).toBeLessThanOrEqual(
            gpuGiB * GIBIBYTE - inferenceMemoryBudget(hardware).deviceHeadroomBytes,
          )
          if (id === BONSAI) expect(fit.model.quant).toBe("PTQ1_0")
        }
      }
    }
  })
})

function appleHardware(memoryGiB: number): HardwareProbe {
  return {
    platform: "darwin",
    arch: "arm64",
    totalMemoryBytes: memoryGiB * GIBIBYTE,
    gpuMemoryBytes: memoryGiB * GIBIBYTE,
    backend: "metal",
    unifiedMemory: true,
    gpuCount: 1,
  }
}

function linuxHardware(ramGiB: number, gpuGiB?: number): HardwareProbe {
  return {
    platform: "linux",
    arch: "x64",
    totalMemoryBytes: ramGiB * GIBIBYTE,
    ...(gpuGiB === undefined ? {} : { gpuMemoryBytes: gpuGiB * GIBIBYTE }),
    backend: "vulkan",
    unifiedMemory: false,
    gpuCount: 1,
  }
}
