import { describe, expect, it, vi } from "vitest"
import {
  availableModelMemory,
  detectHardware,
  inferenceMemoryBudget,
} from "../../src/inference/hardware.js"

/** nvidia-smi rows in the probe's query order: index, uuid, name, then the given fields. */
const smi = (fields: string, mig = "Disabled") =>
  fields
    .split("\n")
    .filter(Boolean)
    .map((line, index) => `${index}, GPU-${index}, NVIDIA GPU, ${line}, ${mig}`)
    .join("\n")
const twoGpus = smi("24576, 610.43.02, 8.9\n8192, 610.43.02, 8.6")

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
      nvidiaSmi: async () => smi(output),
      glibcVersion: async () => glibc,
    })
    expect(hardware.backend).toBe(cudaVersion ? "cuda" : "vulkan")
    expect(hardware.gpuVendor).toBe("nvidia")
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
      env: {
        platform: "darwin",
        arch: "arm64",
        totalMemoryBytes: 64 * 1024 ** 3,
        release: "24.6.0",
      },
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
  ])("models the Metal working set of a %d GiB Mac on macOS 15 as %d bytes", async (ramGiB, bytes) => {
    const probe = (metalWiredLimitMiB: () => Promise<number | undefined>) =>
      detectHardware({
        env: {
          platform: "darwin",
          arch: "arm64",
          totalMemoryBytes: ramGiB * 1024 ** 3,
          release: "24.6.0",
        },
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

  it.each([
    // MTLCreateSystemDefaultDevice().recommendedMaxWorkingSetSize on an Apple M4 Max MacBook Pro
    // with 36 GiB (hw.memsize 38,654,705,664) on macOS 27.0 (Darwin 27.0.0), iogpu.wired_limit_mb
    // 0; llama-server b10666 reports the same 28753 MiB as its MTL0 device memory.
    [36, "27.0.0", 30_150_672_384],
    // M2 Max with 32 GiB on macOS 26.5.2, as published at
    // https://modelpiper.com/blog/iogpu-wired-limit-mb-mac (26,800,603,136 bytes, 78%).
    [32, "25.5.0", 26_800_603_136],
    // Larger Macs follow the same 78% until measured otherwise; smaller ones keep two thirds.
    [64, "25.0.0", 53_601_206_272],
    [16, "25.0.0", 11_453_246_122],
  ])("models the Metal working set of a %d GiB Mac on Darwin %s as %d bytes", async (ramGiB, release, bytes) => {
    const hardware = await detectHardware({
      env: { platform: "darwin", arch: "arm64", totalMemoryBytes: ramGiB * 1024 ** 3, release },
      metalWiredLimitMiB: async () => 0,
    })
    expect(hardware.gpuMemoryBytes).toBe(bytes)
    if (ramGiB >= 32) expect(bytes % 16_384).toBe(0)
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
      nvidiaSmi: async () => smi("24576\n8192\n"),
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
      nvidiaSmi: async () => (probe === "nvidia" ? smi("24576\n[N/A]\n") : undefined),
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

  it.each([
    ["1", [8192]],
    ["GPU-1", [8192]],
    ["GPU-1,0", [8192, 24576]],
    ["0,7,1", [24576]],
    ["7", []],
    ["", []],
  ])("sums only the GPUs CUDA_VISIBLE_DEVICES=%j exposes", async (visible, memoriesMiB) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      variables: { CUDA_VISIBLE_DEVICES: visible },
      nvidiaSmi: async () => twoGpus,
      glibcVersion: async () => "2.39",
      linuxGraphics: async () => [],
    })
    if (memoriesMiB.length === 0) {
      expect(hardware).toMatchObject({ backend: "cpu", gpuCount: 0 })
      return
    }
    expect(hardware).toMatchObject({
      backend: "cuda",
      gpuCount: memoriesMiB.length,
      gpuMemoryBytes: memoriesMiB.reduce((sum, mib) => sum + mib, 0) * 1024 ** 2,
    })
  })

  it("keeps every GPU when CUDA_VISIBLE_DEVICES is unset", async () => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      variables: {},
      nvidiaSmi: async () => twoGpus,
      glibcVersion: async () => "2.39",
    })
    expect(hardware).toMatchObject({ gpuCount: 2, gpuMemoryBytes: (24576 + 8192) * 1024 ** 2 })
  })

  it("budgets a MIG GPU by its partitions when nvidia-smi reports their memory", async () => {
    const migDevices = vi.fn(async () => [
      { uuid: "MIG-a", memoryMiB: 20_000 },
      { uuid: "MIG-b", memoryMiB: 10_000 },
    ])
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 256 * 1024 ** 3 },
      variables: {},
      nvidiaSmi: async () => smi("81920, 610.43.02, 8.0", "Enabled"),
      migDevices,
      glibcVersion: async () => "2.39",
    })
    expect(migDevices).toHaveBeenCalledWith(expect.objectContaining({ uuid: "GPU-0", mig: true }))
    expect(hardware).toMatchObject({
      backend: "cuda",
      gpuCount: 2,
      gpuMemoryBytes: 30_000 * 1024 ** 2,
      cudaComputeCapabilities: [8, 8],
    })
    expect(hardware.notes).toBeUndefined()
    const partition = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 256 * 1024 ** 3 },
      variables: { CUDA_VISIBLE_DEVICES: "MIG-b" },
      nvidiaSmi: async () => smi("81920, 610.43.02, 8.0", "Enabled"),
      migDevices,
      glibcVersion: async () => "2.39",
    })
    expect(partition).toMatchObject({ gpuCount: 1, gpuMemoryBytes: 10_000 * 1024 ** 2 })
  })

  it.each([
    ["mig.mode.current", "NVIDIA A100 80GB", "Enabled"],
    ["its name", "NVIDIA A100 MIG 3g.40gb", "[N/A]"],
  ])("falls back to the whole MIG GPU (detected by %s) with a note when partitions are unreadable", async (_by, name, mig) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 256 * 1024 ** 3 },
      variables: {},
      nvidiaSmi: async () => `0, GPU-0, ${name}, 81920, 610.43.02, 8.0, ${mig}`,
      migDevices: async () => [{ uuid: "MIG-a" }],
      glibcVersion: async () => "2.39",
    })
    expect(hardware).toMatchObject({ gpuCount: 1, gpuMemoryBytes: 81920 * 1024 ** 2 })
    expect(hardware.notes).toEqual([
      `GPU 0 (${name}) is in MIG mode; its partitions could not be read, so the whole GPU was budgeted.`,
    ])
  })

  it.each([
    [16 * 1024 ** 3, 16 * 1024 ** 3],
    [undefined, 64 * 1024 ** 3],
    [256 * 1024 ** 3, 64 * 1024 ** 3],
  ])("caps Linux host memory at a cgroup limit of %s", async (limit, totalMemoryBytes) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      cgroupMemoryLimitBytes: async () => limit,
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [],
    })
    expect(hardware.totalMemoryBytes).toBe(totalMemoryBytes)
  })

  it("does not consult cgroups outside Linux", async () => {
    const cgroupMemoryLimitBytes = vi.fn(async () => 1024 ** 3)
    const hardware = await detectHardware({
      env: {
        platform: "darwin",
        arch: "arm64",
        totalMemoryBytes: 64 * 1024 ** 3,
        release: "24.6.0",
      },
      cgroupMemoryLimitBytes,
      metalWiredLimitMiB: async () => 0,
    })
    expect(cgroupMemoryLimitBytes).not.toHaveBeenCalled()
    expect(hardware.totalMemoryBytes).toBe(64 * 1024 ** 3)
  })

  it.each([
    ["amdgpu", "amd"],
    ["i915", "intel"],
    ["xe", "intel"],
  ])("records the vendor of %s integrated graphics", async (driver, gpuVendor) => {
    const hardware = await detectHardware({
      env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * 1024 ** 3 },
      nvidiaSmi: async () => undefined,
      linuxGraphics: async () => [
        driver === "amdgpu"
          ? { driver, memoryTotalBytes: 512 * 1024 ** 2, gttTotalBytes: 32 * 1024 ** 3 }
          : { driver },
      ],
    })
    expect(hardware).toMatchObject({ unifiedMemory: true, gpuVendor })
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
