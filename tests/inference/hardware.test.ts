import { describe, expect, it } from "vitest"
import {
  availableModelMemory,
  detectHardware,
  inferenceMemoryBudget,
} from "../../src/inference/hardware.js"

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
    const capabilities = output.split("\n").map((line) => Number(line.split(",")[2]))
    expect(hardware.cudaComputeCapabilities).toEqual(
      capabilities.every(Number.isFinite) ? capabilities : undefined,
    )
    expect(inferenceMemoryBudget(hardware).deviceHeadroomBytes).toBe(1024 ** 3)
  })

  it("treats Apple Silicon as Metal with a working set inside unified memory", async () => {
    const hardware = await detectHardware({
      env: { platform: "darwin", arch: "arm64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      metalWiredLimitMiB: async () => 0,
    })
    expect(hardware).toMatchObject({
      backend: "metal",
      unifiedMemory: true,
      gpuCount: 1,
      gpuMemoryBytes: 48 * 1024 ** 3,
    })
    // llama.cpp's own per-device margin; the system headroom applies to the host pool only.
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuMemoryBudgetBytes: 47 * 1024 ** 3,
    })
    expect(availableModelMemory(hardware)).toBe(64 * 1024 ** 3 - 9_831 * 1024 ** 2)
  })

  it.each([
    [8, 5_726_623_061],
    [16, 11_453_246_122],
    [36, 24 * 1024 ** 3],
    [48, 36 * 1024 ** 3],
    [192, 144 * 1024 ** 3],
  ])("models the default Metal working set of a %d GiB Mac as %d bytes", async (ramGiB, bytes) => {
    const probe = (metalWiredLimitMiB: () => Promise<number | undefined>) =>
      detectHardware({
        env: { platform: "darwin", arch: "arm64", totalMemoryBytes: ramGiB * 1024 ** 3 },
        metalWiredLimitMiB,
      })
    expect((await probe(async () => 0)).gpuMemoryBytes).toBe(bytes)
    expect((await probe(async () => undefined)).gpuMemoryBytes).toBe(bytes)
    expect(
      (
        await probe(async () => {
          throw new Error("sysctl: unknown oid")
        })
      ).gpuMemoryBytes,
    ).toBe(bytes)
  })

  it("uses a raised iogpu.wired_limit_mb as the Metal working set", async () => {
    const hardware = await detectHardware({
      env: { platform: "darwin", arch: "arm64", totalMemoryBytes: 96 * 1024 ** 3 },
      metalWiredLimitMiB: async () => 86_016,
    })
    expect(hardware.gpuMemoryBytes).toBe(86_016 * 1024 ** 2)
    expect(inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes).toBe(83 * 1024 ** 3)
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
    expect(hardware.cudaComputeCapabilities).toBeUndefined()
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuMemoryBudgetBytes: 30 * 1024 ** 3,
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
      gpuMemoryBudgetBytes: 31 * 1024 ** 3,
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

  it.each([
    16, 128, 512,
  ])("keeps GPU headroom independent of %d GiB host RAM when VRAM is unknown", async (ramGiB) => {
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
      linuxGraphics: async () => [
        { memoryTotalBytes: 16 * 1024 ** 3 },
        { memoryTotalBytes: 8 * 1024 ** 3 },
      ],
    })
    expect(hardware).toMatchObject({ gpuCount: 2, gpuMemoryBytes: 24 * 1024 ** 3 })
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuMemoryBudgetBytes: 22 * 1024 ** 3,
    })
  })

  it.each([
    "nvidia",
    "drm",
  ])("retains the GPU count when %s reports incomplete VRAM", async (probe) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 128 * 1024 ** 3 },
      nvidiaSmi: async () => (probe === "nvidia" ? "24576\n[N/A]\n" : undefined),
      linuxGraphics: async () => [{ memoryTotalBytes: 24 * 1024 ** 3 }, {}],
    })
    expect(hardware).toMatchObject({ backend: "vulkan", gpuCount: 2 })
    expect(hardware.gpuMemoryBytes).toBeUndefined()
    expect(inferenceMemoryBudget(hardware)).toEqual({ deviceHeadroomBytes: 1024 ** 3 })
  })

  it.each([
    [
      "an AMD APU",
      { driver: "amdgpu", memoryTotalBytes: 512 * 1024 ** 2, gttTotalBytes: 64 * 1024 ** 3 },
    ],
    [
      "Strix Halo",
      { driver: "amdgpu", memoryTotalBytes: 4 * 1024 ** 3, gttTotalBytes: 96 * 1024 ** 3 },
    ],
    ["an Intel iGPU under i915", { driver: "i915" }],
    ["an Intel iGPU under xe", { driver: "xe" }],
  ])("treats %s as unified memory budgeted from host RAM", async (_name, device) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 128 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [device],
    })
    expect(hardware).toMatchObject({
      backend: "vulkan",
      unifiedMemory: true,
      gpuCount: 1,
      gpuMemoryBytes: 128 * 1024 ** 3,
    })
    expect(inferenceMemoryBudget(hardware)).toEqual({
      deviceHeadroomBytes: 1024 ** 3,
      gpuMemoryBudgetBytes: 127 * 1024 ** 3,
    })
    expect(availableModelMemory(hardware)).toBe(128 * 1024 ** 3 - 13_108 * 1024 ** 2)
  })

  it.each([
    [
      "a discrete AMD card",
      { driver: "amdgpu", memoryTotalBytes: 16 * 1024 ** 3, gttTotalBytes: 16 * 1024 ** 3 },
    ],
    [
      "a small AMD card without a large GTT",
      { driver: "amdgpu", memoryTotalBytes: 4 * 1024 ** 3, gttTotalBytes: 4 * 1024 ** 3 },
    ],
    ["an Intel Arc card reporting VRAM", { driver: "xe", memoryTotalBytes: 16 * 1024 ** 3 }],
  ])("keeps %s dedicated", async (_name, device) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [device],
    })
    expect(hardware).toMatchObject({
      backend: "vulkan",
      unifiedMemory: false,
      gpuCount: 1,
      gpuMemoryBytes: device.memoryTotalBytes,
    })
  })

  it("budgets a discrete card and ignores the APU beside it", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [
        { driver: "amdgpu", memoryTotalBytes: 512 * 1024 ** 2, gttTotalBytes: 32 * 1024 ** 3 },
        { driver: "amdgpu", memoryTotalBytes: 24 * 1024 ** 3, gttTotalBytes: 24 * 1024 ** 3 },
      ],
    })
    expect(hardware).toMatchObject({
      unifiedMemory: false,
      gpuCount: 1,
      gpuMemoryBytes: 24 * 1024 ** 3,
    })
    expect(inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes).toBe(23 * 1024 ** 3)
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
