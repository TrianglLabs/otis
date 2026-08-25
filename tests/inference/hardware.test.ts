import { describe, expect, it } from "vitest"
import {
  availableInferenceMemory,
  currentlyAvailableInferenceMemory,
  detectHardware,
  inferenceMemoryBudget,
} from "../../src/inference/hardware.js"

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
    expect(availableInferenceMemory(hardware)).toBe(hardware.totalMemoryBytes - budget.deviceHeadroomBytes)
  })

  it("uses NVIDIA VRAM and Vulkan on Linux", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 32 * 1024 ** 3 },
      nvidiaSmi: async () => "24576, 20480\n8192, 4096\n",
    })
    expect(hardware.backend).toBe("vulkan")
    expect(hardware.gpuMemoryBytes).toBe((24576 + 8192) * 1024 * 1024)
    expect(hardware.gpuMemoryFreeBytes).toBe((20480 + 4096) * 1024 * 1024)
    expect(hardware.gpuDeviceCount).toBe(2)
    expect(hardware.unifiedMemory).toBe(false)
    expect(availableInferenceMemory(hardware)).toBe((24576 + 8192 - 2048) * 1024 * 1024)
    expect(currentlyAvailableInferenceMemory(hardware)).toBe((20480 + 4096 - 2048) * 1024 * 1024)
  })

  it("does not treat host RAM as available VRAM on discrete GPUs", () => {
    const hardware = {
      platform: "linux" as const,
      arch: "x64",
      totalMemoryBytes: 32 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
      gpuMemoryFreeBytes: 3 * 1024 ** 3,
      backend: "vulkan" as const,
      unifiedMemory: false,
    }
    expect(availableInferenceMemory(hardware)).toBe(7 * 1024 ** 3)
    expect(currentlyAvailableInferenceMemory(hardware)).toBe(2 * 1024 ** 3)
  })

  it("keeps one GiB of headroom on a 32 GB discrete GPU", () => {
    const hardware = {
      platform: "linux" as const,
      arch: "x64",
      totalMemoryBytes: 64 * 1024 ** 3,
      gpuMemoryBytes: 32 * 1024 ** 3,
      gpuMemoryFreeBytes: 32 * 1024 ** 3,
      gpuDeviceCount: 1,
      backend: "vulkan" as const,
      unifiedMemory: false,
    }

    expect(inferenceMemoryBudget(hardware)).toEqual({
      availableBytes: 31 * 1024 ** 3,
      deviceHeadroomBytes: 1024 ** 3,
    })
    expect(currentlyAvailableInferenceMemory(hardware)).toBe(31 * 1024 ** 3)
  })

  it("falls back to CPU when no GPU is reported", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 16 * 1024 ** 3 },
      nvidiaSmi: async () => {
        throw new Error("missing")
      },
    })
    expect(hardware).toMatchObject({ backend: "cpu", unifiedMemory: false })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
  })
})
