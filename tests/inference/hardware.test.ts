import { describe, expect, it } from "vitest"
import { availableModelMemory, detectHardware, inferenceMemoryBudget } from "../../src/inference/hardware.js"

describe("hardware detection", () => {
  it.each([
    ["x64", "2.39", "24576, 570.211.01, 8.9", "12.8"],
    ["x64", "2.39", "24576, 610.43.02, 8.9", "13.3"],
    ["arm64", "2.40", "[N/A], 610.43.02, 12.1", "13.3"],
    ["x64", "2.39", "8192, 610.43.02, 6.1", "12.8"],
    ["x64", "2.39", "8192, 610.43.02, 8.9\n8192, 610.43.02, 6.1", "12.8"],
    ["x64", "2.39", "8192, 570.211.00, 8.6", undefined],
    ["x64", "2.38", "8192, 610.43.02, 8.6", undefined],
    ["x64", undefined, "8192, 610.43.02, 8.6", undefined],
    ["x64", "2.39", "8192, [N/A], 8.6", undefined],
    ["x64", "2.39", "8192, 610.43.02, [N/A]", undefined],
    ["x64", "2.39", "8192, 610.43.02, 3.5", undefined],
    ["x64", "2.39", "8192, 610.43.02, 13.0", undefined],
    ["x64", "2.39", "8192, 580.100.00, 12.1", undefined],
    ["arm64", "2.39", "8192, 580.100.00, 8.7", undefined],
    ["arm64", "2.39", "8192, 610.43.01, 12.1", undefined],
    ["riscv64", "2.39", "8192, 610.43.02, 8.9", undefined],
  ] as const)("selects a compatible CUDA build for %s, glibc %s, NVIDIA %s", async (arch, glibc, output, cudaVersion) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch, totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => output,
      glibcVersion: async () => glibc,
    })
    expect(hardware.backend).toBe(cudaVersion ? "cuda" : "vulkan")
    expect(hardware.cudaVersion).toBe(cudaVersion)
    expect(hardware.gpuCount).toBe(output.split("\n").length)
    expect(inferenceMemoryBudget(hardware).deviceHeadroomBytes).toBe(1024 ** 3)
  })

  it("treats Apple Silicon as Metal with unified memory", async () => {
    const hardware = await detectHardware({
      env: { platform: "darwin", arch: "arm64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
    })
    expect(hardware).toMatchObject({
      backend: "metal",
      unifiedMemory: true,
      gpuCount: 1,
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
    expect(hardware.gpuCount).toBe(2)
    expect(hardware.gpuMemoryBytes).toBe((24576 + 8192) * 1024 * 1024)
    expect(hardware.unifiedMemory).toBe(false)
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuWeightBudgetBytes: 30 * 1024 ** 3,
    })
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
      gpuCount: 1,
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
      gpuCount: 1,
    }

    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuWeightBudgetBytes: 31 * 1024 ** 3,
    })
  })

  it("uses Vulkan for a vendor-neutral Linux render device", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [{ memoryTotalBytes: 16 * 1024 ** 3 }],
    })

    expect(hardware).toMatchObject({ backend: "vulkan", gpuMemoryBytes: 16 * 1024 ** 3 })
  })

  it.each([16, 128, 512])("keeps GPU headroom independent of %d GiB host RAM when VRAM is unknown", async (ramGiB) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "arm64", totalMemoryBytes: ramGiB * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [{}],
    })

    expect(hardware).toMatchObject({ backend: "vulkan", gpuCount: 1 })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
    expect(inferenceMemoryBudget(hardware)).toEqual({ deviceHeadroomBytes: 1024 ** 3 })
  })

  it("reserves headroom for every vendor-neutral GPU", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [{ memoryTotalBytes: 16 * 1024 ** 3 }, { memoryTotalBytes: 8 * 1024 ** 3 }],
    })
    expect(hardware).toMatchObject({ gpuCount: 2, gpuMemoryBytes: 24 * 1024 ** 3 })
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuWeightBudgetBytes: 22 * 1024 ** 3,
    })
  })

  it.each(["nvidia", "drm"])("retains the GPU count when %s reports incomplete VRAM", async (probe) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 128 * 1024 ** 3 },
      nvidiaSmi: async () => (probe === "nvidia" ? "24576\n[N/A]\n" : undefined),
      linuxGraphics: async () => [{ memoryTotalBytes: 24 * 1024 ** 3 }, {}],
    })
    expect(hardware).toMatchObject({ backend: "vulkan", gpuCount: 2 })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
    expect(inferenceMemoryBudget(hardware)).toEqual({ deviceHeadroomBytes: 1024 ** 3 })
  })

  it("falls back to CPU when no GPU is reported", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 16 * 1024 ** 3 },
      nvidiaSmi: async () => {
        throw new Error("missing")
      },
      linuxGraphics: async () => [],
    })
    expect(hardware).toMatchObject({ backend: "cpu", unifiedMemory: false, gpuCount: 0 })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
    expect(inferenceMemoryBudget(hardware)).toEqual({ deviceHeadroomBytes: 2 * 1024 ** 3 })
  })
})
