import { describe, expect, it } from "vitest"
import { availableModelMemory, detectHardware, inferenceMemoryBudget } from "../../src/inference/hardware.js"

describe("hardware detection", () => {
  it("treats Apple Silicon as Metal with unified memory", async () => {
    const hardware = await detectHardware({
      env: { platform: "darwin", arch: "arm64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
    })
    expect(hardware).toMatchObject({
      backend: "metal",
      unifiedMemory: true,
      gpuMemoryBytes: 64 * 1024 ** 3,
    })
    const budget = inferenceMemoryBudget(hardware)
    expect(budget.deviceHeadroomBytes).toBe(9_831 * 1024 ** 2)
    expect(availableModelMemory(hardware)).toBe(hardware.totalMemoryBytes - budget.deviceHeadroomBytes)
  })

  it("uses NVIDIA VRAM and Vulkan on Linux", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 32 * 1024 ** 3 },
      nvidiaSmi: async () => "24576\n8192\n",
    })
    expect(hardware.backend).toBe("vulkan")
    expect(hardware.gpuMemoryBytes).toBe((24576 + 8192) * 1024 * 1024)
    expect(hardware.unifiedMemory).toBe(false)
    expect(availableModelMemory(hardware)).toBe(32 * 1024 ** 3 - 3_277 * 1024 ** 2)
  })

  it("uses host RAM for model capacity while preserving a separate VRAM budget", () => {
    const hardware = {
      platform: "linux" as const,
      arch: "x64",
      totalMemoryBytes: 32 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
      backend: "vulkan" as const,
      unifiedMemory: false,
    }
    expect(inferenceMemoryBudget(hardware).deviceHeadroomBytes).toBe(1024 ** 3)
    expect(availableModelMemory(hardware)).toBe(32 * 1024 ** 3 - 3_277 * 1024 ** 2)
  })

  it("keeps one GiB of headroom on a 32 GB discrete GPU", () => {
    const hardware = {
      platform: "linux" as const,
      arch: "x64",
      totalMemoryBytes: 64 * 1024 ** 3,
      gpuMemoryBytes: 32 * 1024 ** 3,
      backend: "vulkan" as const,
      unifiedMemory: false,
    }

    expect(inferenceMemoryBudget(hardware)).toEqual({ deviceHeadroomBytes: 1024 ** 3 })
  })

  it("uses Vulkan for a vendor-neutral Linux render device", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [{ memoryTotalBytes: 16 * 1024 ** 3 }],
    })

    expect(hardware).toMatchObject({ backend: "vulkan", gpuMemoryBytes: 16 * 1024 ** 3 })
  })

  it("uses Vulkan when a Linux render device does not report dedicated memory", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "arm64", totalMemoryBytes: 32 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [{}],
    })

    expect(hardware).toMatchObject({ backend: "vulkan" })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
    expect(inferenceMemoryBudget(hardware).deviceHeadroomBytes).toBe(3_277 * 1024 ** 2)
  })

  it("falls back to CPU when no GPU is reported", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 16 * 1024 ** 3 },
      nvidiaSmi: async () => {
        throw new Error("missing")
      },
      linuxGraphics: async () => [],
    })
    expect(hardware).toMatchObject({ backend: "cpu", unifiedMemory: false })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
  })
})
