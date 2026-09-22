import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  availableModelMemory,
  detectHardware,
  type HardwareProbe,
  inferenceMemoryBudget,
} from "../../src/inference/hardware.js"
import {
  findLocalModel,
  LOCAL_MODELS,
  type LocalModelSpec,
  localModelPackings,
} from "../../src/inference/local-catalog.js"
import {
  fitLocalModel,
  formatMemoryLabel,
  memoryRequiredFor,
} from "../../src/inference/local-fit.js"
import {
  formatContextWindow,
  isSelectablePickerItem,
  type LocalPickerChoice,
  listModelPickerItems,
  type PairPickerChoice,
} from "../../src/inference/picker-catalog.js"
import { fireworksModel } from "../../src/inference/types.js"

const ample: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 128 * 1024 ** 3,
  gpuMemoryBytes: 128 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
  gpuCount: 1,
}

const tight: HardwareProbe = {
  ...ample,
  totalMemoryBytes: 8 * 1024 ** 3,
  gpuMemoryBytes: 8 * 1024 ** 3,
}

const GIBIBYTE = 1024 ** 3
const LFM = "LiquidAI/LFM2.5-2.6B"
const BONSAI = "prism-ml/Ternary-Bonsai-2-27B-gguf"
const QWEN = "Qwen/Qwen3.8-27B"
const FLASH = "Qwen/Qwen3.8-Flash-Next"
const GLM = "zai-org/GLM-5.3"
const ORNITH = "ornith-ai/Ornith-1.5-9B"
const GEMMA = "google/gemma-4-12B-it"
const GPT_OSS = "openai/gpt-oss-20b"
const GEMMA_A4B = "google/gemma-4-26B-A4B-it"
const GEMMA_31B = "google/gemma-4-31B-it"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("model picker catalog", () => {
  it("keeps undersized oMLX models visible with a configuration reason and disables selection", async () => {
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      omlxModels: [8192, 65536, undefined].map((contextLength) => ({
        provider: "omlx",
        id: `chat-${contextLength}`,
        displayName: "Chat",
        baseURL: "http://127.0.0.1:8000",
        supportsImageInput: false,
        contextLength,
      })),
    })
    const models = items.filter((item) => item.kind === "model" && item.provider === "omlx")
    expect(models).toHaveLength(3)
    expect(models[0]).toMatchObject({
      available: false,
      availabilityLabel: expect.stringContaining("Requires 64K"),
    })
    expect(isSelectablePickerItem(models[0])).toBe(false)
    expect(isSelectablePickerItem(models[1])).toBe(true)
    expect(isSelectablePickerItem(models[2])).toBe(true)
  })

  it.each([
    [8, [LFM]],
    [16, [ORNITH, GEMMA]],
    [18, [ORNITH, GEMMA]],
    [24, [BONSAI]],
    [32, [BONSAI]],
    [36, [BONSAI]],
    [48, [QWEN]],
    [64, [QWEN]],
    [96, [QWEN]],
    [128, [FLASH]],
    [192, [FLASH]],
    [256, [FLASH]],
    [384, [FLASH]],
    [512, [GLM]],
    [1024, [GLM]],
  ])("stars models that fit the Metal working set of a %d GiB Mac at 64K", async (ramGiB, ids) => {
    const hardware = await macHardware(ramGiB)
    const items = await listModelPickerItems({ hardware, dataDirectory: await tempDir() })
    const recommended = items.filter(
      (item): item is LocalPickerChoice =>
        item.kind === "model" && item.provider === "local" && item.recommended,
    )
    expect(recommended.map((model) => model.id)).toEqual(ids)
    // macOS wires two thirds of RAM up to 36 GiB and three quarters above; llama.cpp then keeps
    // its 1 GiB margin, so a starred model must hold 64K inside what remains.
    const workingSet = Math.floor(
      (ramGiB * GIBIBYTE * (ramGiB <= 36 ? 2 : 3)) / (ramGiB <= 36 ? 3 : 4),
    )
    expect(hardware.gpuMemoryBytes).toBe(workingSet)
    for (const row of recommended) {
      const model = findLocalModel(row.id)
      if (!model) throw new Error(`missing catalog entry: ${row.id}`)
      const fit = fitLocalModel(model, hardware)
      expect(fit.requiresCpuOffload).toBe(false)
      expect(memoryRequiredFor(fit.model, 65_536)).toBeLessThanOrEqual(workingSet - GIBIBYTE)
      expect(row.cpuOffload).toBe(false)
    }
  })

  it("stars a GPU-resident model on a 96 GiB Mac once iogpu.wired_limit_mb is raised", async () => {
    await expect(recommendedIds(await macHardware(96))).resolves.toEqual([QWEN])
    await expect(recommendedIds(await macHardware(96, 86_016))).resolves.toEqual([FLASH])
  })

  it.each([
    [16, "PTQ1_0"],
    [24, "PQ2_0"],
  ])("shows the selected Bonsai packing at %d GB", async (memoryGB, quant) => {
    const items = await listModelPickerItems({
      hardware: {
        ...ample,
        totalMemoryBytes: memoryGB * 1024 ** 3,
        gpuMemoryBytes: memoryGB * 1024 ** 3,
      },
      dataDirectory: await tempDir(),
    })
    const bonsai = items.find(
      (item): item is LocalPickerChoice =>
        item.kind === "model" &&
        item.provider === "local" &&
        item.id === "prism-ml/Ternary-Bonsai-2-27B-gguf",
    )
    expect(bonsai?.availabilityLabel).toContain(`· ${quant}`)
  })

  it.each([
    [8188, [LFM]],
    [8191, [LFM]],
    [8192, [LFM]],
    [12288, [ORNITH, GEMMA]],
    [16380, [BONSAI]],
  ])("stars models whose full footprint fits %d MiB of Vulkan VRAM", async (gpuMiB, ids) => {
    await expect(
      recommendedIds({ ...linuxHardware(15.8, 8), gpuMemoryBytes: gpuMiB * 1024 ** 2 }),
    ).resolves.toEqual(ids)
  })

  it.each([
    // Nothing fits 4 GiB whole, so the host-bandwidth order applies with CPU offload.
    [4, [FLASH]],
    [6, [LFM]],
    [8, [LFM]],
    [12, [ORNITH, GEMMA]],
    [16, [BONSAI]],
    [20, [BONSAI]],
    [24, [BONSAI]],
    [32, [QWEN]],
    [48, [QWEN]],
    [64, [QWEN]],
    [80, [QWEN]],
    [96, [FLASH]],
    [192, [FLASH]],
    [256, [FLASH]],
    [384, [GLM]],
    [1024, [GLM]],
  ])("budgets the full footprint in %d GiB dedicated VRAM", async (gpuGiB, ids) => {
    await expect(recommendedIds(linuxHardware(1024, gpuGiB))).resolves.toEqual(ids)
  })

  it.each([
    32, 64, 128, 256, 1024,
  ])("keeps the 24 GiB GPU recommendation stable with %d GiB host RAM", async (ramGiB) => {
    await expect(recommendedIds(linuxHardware(ramGiB, 24))).resolves.toEqual([BONSAI])
  })

  it.each([
    8, 16, 32,
  ])("keeps a GPU-resident recommendation independent of %d GiB host RAM", async (ramGiB) => {
    await expect(recommendedIds(linuxHardware(ramGiB, 96))).resolves.toEqual([FLASH])
  })

  it("keeps the 27B and 31B models selectable on 16 GiB RAM with a 24 GiB card", async () => {
    const items = await listModelPickerItems({
      hardware: linuxHardware(16, 24),
      dataDirectory: await tempDir(),
    })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(local.map((item) => item.id)).toEqual([
      BONSAI,
      QWEN,
      ORNITH,
      GEMMA,
      LFM,
      GPT_OSS,
      GEMMA_A4B,
      GEMMA_31B,
    ])
    for (const id of [QWEN, GEMMA_31B]) {
      expect(local.find((item) => item.id === id)).toMatchObject({
        available: true,
        recommended: false,
        cpuOffload: true,
      })
    }
  })

  it("includes weights, 64K cache, runtime buffers, and headroom at the VRAM boundary", async () => {
    const hardware = linuxHardware(64, 24)
    const model = findLocalModel(QWEN)
    if (!model) throw new Error("missing Qwen catalog entry")
    const boundary =
      memoryRequiredFor(model, 65_536) + inferenceMemoryBudget(hardware).deviceHeadroomBytes
    await expect(recommendedIds({ ...hardware, gpuMemoryBytes: boundary })).resolves.toEqual([QWEN])
    await expect(recommendedIds({ ...hardware, gpuMemoryBytes: boundary - 1 })).resolves.toEqual([
      BONSAI,
    ])
  })

  it("accounts for each GPU's margin before recommending a larger model", async () => {
    const probe = async (nvidiaOutput: string) =>
      detectHardware({
        env: { platform: "linux", arch: "x64", totalMemoryBytes: 64 * GIBIBYTE },
        nvidiaSmi: async () => nvidiaOutput,
      })
    // Equal combined VRAM, but two devices need 2 GiB rather than 1 GiB of headroom.
    const single = await probe("25600\n")
    const dual = await probe("12800\n12800\n")
    expect(single.gpuMemoryBytes).toBe(dual.gpuMemoryBytes)
    await expect(recommendedIds(single)).resolves.toEqual([QWEN])
    await expect(recommendedIds(dual)).resolves.toEqual([BONSAI])
  })

  it("falls back at the exact working-set boundary without rounding memory upward", async () => {
    const model = findLocalModel(BONSAI)
    const packing = model && localModelPackings(model).find(({ quant }) => quant === "PQ2_0")
    if (!packing) throw new Error("missing Bonsai packing")
    // Above 16 GiB Bonsai uses PQ2, and two thirds of RAM less llama.cpp's margin must hold it.
    const totalMemoryBytes = ((memoryRequiredFor(packing, 65_536) + GIBIBYTE) * 3) / 2
    await expect(recommendedIds(await macHardware(totalMemoryBytes / GIBIBYTE))).resolves.toEqual([
      BONSAI,
    ])
    await expect(
      recommendedIds(await macHardware((totalMemoryBytes - 2) / GIBIBYTE)),
    ).resolves.toEqual([ORNITH, GEMMA])
  })

  it.each([
    [8, [LFM]],
    [12, [ORNITH, GEMMA]],
    [16, [ORNITH, GEMMA]],
    [24, [GPT_OSS, GEMMA_A4B]],
    [32, [GPT_OSS, GEMMA_A4B]],
    [128, [FLASH]],
    [1024, [FLASH]],
  ])("prefers mixtures of experts and small dense models on a CPU-only host with %d GiB RAM", async (ramGiB, ids) => {
    // Stale GPU metadata must not constrain CPU recommendations.
    const hardware: HardwareProbe = { ...linuxHardware(ramGiB, 1), backend: "cpu" }
    await expect(recommendedIds(hardware)).resolves.toEqual(ids)
    if (ramGiB < 32) return
    // The 27B dense model fits host RAM but would decode at one or two tokens per second.
    const items = await listModelPickerItems({ hardware, dataDirectory: await tempDir() })
    expect(items.find((item) => item.kind === "model" && item.id === QWEN)).toMatchObject({
      available: true,
      recommended: false,
    })
  })

  it("uses the CPU preference order when a Vulkan device does not report VRAM", async () => {
    await expect(recommendedIds(linuxHardware(32))).resolves.toEqual([GPT_OSS, GEMMA_A4B])
  })

  it("does not recommend when nothing fits 4 GiB of unified memory", async () => {
    await expect(recommendedIds(await macHardware(4))).resolves.toEqual([])
  })

  it.each([
    GIBIBYTE,
    2 * GIBIBYTE,
  ])("falls back to the CPU preference order when %d bytes of VRAM hold no model", async (gpuMemoryBytes) => {
    await expect(recommendedIds({ ...linuxHardware(64, 24), gpuMemoryBytes })).resolves.toEqual([
      GPT_OSS,
      GEMMA_A4B,
    ])
  })

  it("does not recommend local models on an unsupported runtime target", async () => {
    await expect(recommendedIds({ ...linuxHardware(64), platform: "win32" })).resolves.toEqual([])
    await expect(recommendedIds({ ...linuxHardware(64), arch: "ia32" })).resolves.toEqual([])
  })

  it("stars only GPU-resident fits, or hybrid fits inside GPU plus host memory", async () => {
    const directory = await tempDir()
    for (const ramGiB of [8, 12, 16, 24, 32, 64, 96, 196, 256, 384, 1024]) {
      for (const gpuGiB of [4, 8, 16, 24, 48, 80, 96, 384]) {
        const hardware = linuxHardware(ramGiB, gpuGiB)
        const ids = await recommendedIds(hardware, directory)
        expect(ids.length).toBeGreaterThan(0)
        const gpuBudget = gpuGiB * GIBIBYTE - inferenceMemoryBudget(hardware).deviceHeadroomBytes
        for (const id of ids) {
          const model = findLocalModel(id)
          if (!model) throw new Error(`missing catalog entry: ${id}`)
          const fit = fitLocalModel(model, hardware)
          expect(fit.available).toBe(true)
          expect(fit.contextLength).toBeGreaterThanOrEqual(65_536)
          const required = memoryRequiredFor(fit.model, fit.contextLength)
          expect(required).toBeLessThanOrEqual(fit.memoryAvailableBytes)
          expect(required).toBeLessThanOrEqual(
            fit.requiresCpuOffload ? gpuBudget + availableModelMemory(hardware) : gpuBudget,
          )
          if (id === BONSAI) expect(fit.model.quant).toBe("PTQ1_0")
        }
      }
    }
  })

  it("shows the GPU-budgeted context and memory cost, and labels manual CPU offload", async () => {
    const model = findLocalModel("Qwen/Qwen3.8-27B")
    if (!model) throw new Error("missing catalog entry")
    for (const gpuGiB of [24, 32]) {
      const items = await listModelPickerItems({
        hardware: {
          platform: "linux",
          arch: "x64",
          backend: "vulkan",
          unifiedMemory: false,
          gpuCount: 1,
          totalMemoryBytes: 64 * 1024 ** 3,
          gpuMemoryBytes: gpuGiB * 1024 ** 3,
        },
        dataDirectory: await tempDir(),
      })
      const row = items.find(
        (item): item is LocalPickerChoice =>
          item.kind === "model" && item.provider === "local" && item.id === model.id,
      )
      if (!row) throw new Error("missing picker row")
      expect(isSelectablePickerItem(row)).toBe(true)
      expect(row.recommended).toBe(gpuGiB === 32)
      expect(row.contextLength).toBe(gpuGiB === 32 ? 193_536 : 65_536)
      expect(row.availabilityLabel).toContain(
        formatMemoryLabel(memoryRequiredFor(model, row.contextLength)),
      )
      expect(row.cpuOffload).toBe(gpuGiB === 24)
    }
  })

  it("distinguishes the selected Bonsai packing from another cached packing", async () => {
    const model = findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")
    const compact = model && localModelPackings(model).find(({ quant }) => quant === "PTQ1_0")
    if (!model || !compact) throw new Error("missing Bonsai packing")
    const directory = await tempDir()
    const path = localGgufPath(compact, directory)
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(path, "")
    await truncate(path, compact.ggufFiles[0].size)

    const items = await listModelPickerItems({
      hardware: { ...ample, totalMemoryBytes: 24 * 1024 ** 3, gpuMemoryBytes: 24 * 1024 ** 3 },
      dataDirectory: directory,
    })
    const bonsai = items.find(
      (item): item is LocalPickerChoice =>
        item.kind === "model" && item.provider === "local" && item.id === model.id,
    )
    expect(bonsai).toMatchObject({ downloaded: false, hasDownloadedPacking: true })
    expect(bonsai?.availabilityLabel).toContain("· PQ2_0")
  })

  it("lists local models in recommendation order above hosted entries", async () => {
    const items = await listModelPickerItems({
      hardware: await macHardware(512),
      dataDirectory: await tempDir(),
      currentModel: "accounts/fireworks/models/inkling",
      fireworksApiKey: "fw_test",
      listFireworks: async () => [
        fireworksModel({
          id: "accounts/fireworks/models/inkling",
          displayName: "Inkling",
          supportsImageInput: false,
        }),
      ],
    })

    expect(items[0]).toEqual({ kind: "header", id: "header-local", displayName: "Local" })
    // The star first, then the preference order, then the rest in catalog order.
    expect(
      items.slice(1, 1 + LOCAL_MODELS.length).map((item) => ("id" in item ? item.id : undefined)),
    ).toEqual([GLM, FLASH, QWEN, BONSAI, ORNITH, GEMMA, LFM, GPT_OSS, GEMMA_A4B, GEMMA_31B])
    expect(items[1]).toMatchObject({ recommended: true })
    const hostedHeader = items.findIndex(
      (item) => item.kind === "header" && item.displayName === "Hosted",
    )
    expect(hostedHeader).toBe(1 + LOCAL_MODELS.length)
    expect(items[hostedHeader + 1]).toMatchObject({
      id: "accounts/fireworks/models/inkling",
      provider: "fireworks",
      active: true,
      available: true,
    })
  })

  it("hides local models that do not fit the detected system memory", async () => {
    const items = await listModelPickerItems({ hardware: tight, dataDirectory: await tempDir() })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(local).toEqual([
      expect.objectContaining({
        id: "LiquidAI/LFM2.5-2.6B",
        recommended: true,
        downloaded: false,
      }),
    ])
    expect(local[0]).toMatchObject({
      available: true,
      availabilityLabel: expect.stringMatching(/^Est\. /),
    })
  })

  it("keeps a downloaded over-budget model listed when included, with selection unavailable", async () => {
    const directory = await tempDir()
    const cached = LOCAL_MODELS.find((model) => model.id === "openai/gpt-oss-20b")
    if (!cached) throw new Error("missing catalog entry")
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(localGgufPath(cached, directory), "")
    await truncate(localGgufPath(cached, directory), cached.ggufFiles[0].size)

    const withCached = await listModelPickerItems({
      hardware: tight,
      dataDirectory: directory,
      includeDownloadedUnavailable: true,
    })
    const cachedRow = withCached.find(
      (item): item is LocalPickerChoice =>
        item.kind === "model" && "id" in item && item.id === cached.id,
    )
    // Listed so its cached files stay deletable from the catalog, but never selectable.
    expect(cachedRow).toMatchObject({ available: false, downloaded: true, recommended: false })
    expect(cachedRow?.availabilityLabel).toMatch(/^Needs /)
    expect(isSelectablePickerItem(cachedRow)).toBe(false)

    // The default catalog keeps hiding it — CLI behavior is unchanged.
    const byDefault = await listModelPickerItems({ hardware: tight, dataDirectory: directory })
    expect(byDefault.some((item) => "id" in item && item.id === cached.id)).toBe(false)
  })

  it("omits an empty Local section when no catalog model fits", async () => {
    const items = await listModelPickerItems({
      hardware: { ...tight, totalMemoryBytes: 4 * 1024 ** 3, gpuMemoryBytes: 4 * 1024 ** 3 },
      dataDirectory: await tempDir(),
      fireworksApiKey: "fw_test",
      listFireworks: async () => [
        fireworksModel({
          id: "accounts/fireworks/models/alpha",
          displayName: "Alpha",
          supportsImageInput: false,
        }),
      ],
    })

    expect(items.some((item) => item.kind === "header" && item.id === "header-local")).toBe(false)
    expect(items[0]).toMatchObject({ kind: "header", id: "header-hosted" })
  })

  it("keeps hybrid-offload models available when system RAM is sufficient", async () => {
    const smallGpu: HardwareProbe = {
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 64 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
      backend: "vulkan",
      unifiedMemory: false,
      gpuCount: 1,
    }
    const directory = await tempDir()
    const items = await listModelPickerItems({ hardware: smallGpu, dataDirectory: directory })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )

    expect(local.every((item) => item.available)).toBe(true)
    expect(local.every((item) => item.availabilityLabel.startsWith("Est. "))).toBe(true)
  })

  it("greys out local models on unsupported platforms before selection", async () => {
    const items = await listModelPickerItems({
      hardware: { ...ample, platform: "win32", arch: "x64", backend: "cpu", unifiedMemory: false },
      dataDirectory: await tempDir(),
    })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )

    expect(local.every((item) => !item.available)).toBe(true)
    expect(local.every((item) => !item.recommended)).toBe(true)
    expect(
      local.every(
        (item) => item.availabilityLabel === "Local inference is not supported on win32/x64.",
      ),
    ).toBe(true)
  })

  it("marks local models that are already on disk", async () => {
    const directory = await tempDir()
    const cached = LOCAL_MODELS.find((model) => model.id === "openai/gpt-oss-20b")
    if (!cached) throw new Error("missing catalog entry")
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(localGgufPath(cached, directory), "")
    await truncate(localGgufPath(cached, directory), cached.ggufFiles[0].size)

    const items = await listModelPickerItems({ hardware: ample, dataDirectory: directory })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(local.find((item) => item.id === cached.id)?.downloaded).toBe(true)
    expect(
      local.filter((item) => item.id !== cached.id).every((item) => item.downloaded === false),
    ).toBe(true)
  })

  it("distinguishes a loaded context from estimates for other local models", async () => {
    const model = LOCAL_MODELS.find((candidate) => candidate.id === "Qwen/Qwen3.8-27B")
    if (!model) throw new Error("missing catalog entry")

    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      currentModel: model.id,
      loadedLocalModel: { model: model.id, contextLength: 80_128 },
    })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    const active = local.find((item) => item.id === model.id)

    expect(active).toMatchObject({
      active: true,
      contextLength: 80_128,
      loadedContextLength: 80_128,
    })
    expect(active?.availabilityLabel).toMatch(/^80K · Q4_K_M · /)
    expect(
      local
        .filter((item) => item.id !== model.id)
        .every((item) => item.availabilityLabel.startsWith("Est. ")),
    ).toBe(true)
  })

  it("attaches in-flight load status to the matching local row", async () => {
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      loadStatus: {
        modelId: "openai/gpt-oss-20b",
        status: { label: "Downloading 47%", kind: "progress" },
      },
    })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(local.find((item) => item.id === "openai/gpt-oss-20b")?.status).toEqual({
      label: "Downloading 47%",
      kind: "progress",
    })
    expect(
      local
        .filter((item) => item.id !== "openai/gpt-oss-20b")
        .every((item) => item.status === undefined),
    ).toBe(true)
  })

  it("attaches load status to a PAIR row by selectionKey, not by bare model id", async () => {
    const pairModel = {
      provider: "pair" as const,
      id: "qwen3:32b",
      displayName: "qwen3:32b",
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama" as const,
      nativeContextLength: 262_144,
      supportsImageInput: false,
    }
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      pairModels: [pairModel],
      loadStatus: {
        modelId: "pair:ollama:qwen3:32b",
        status: { label: "Failed: endpoint went away", kind: "error" },
      },
    })
    const pair = items.filter(
      (item): item is PairPickerChoice => item.kind === "model" && item.provider === "pair",
    )
    expect(pair).toHaveLength(1)
    expect(pair[0]?.status).toEqual({ label: "Failed: endpoint went away", kind: "error" })

    // A bare model id never matches a PAIR row.
    const unmatched = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      pairModels: [pairModel],
      loadStatus: { modelId: "qwen3:32b", status: { label: "Failed", kind: "error" } },
    })
    const unmatchedPair = unmatched.filter(
      (item): item is PairPickerChoice => item.kind === "model" && item.provider === "pair",
    )
    expect(unmatchedPair[0]?.status).toBeUndefined()
  })

  it("still shows local models when the Fireworks catalog fails", async () => {
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      fireworksApiKey: "fw_test",
      listFireworks: async () => {
        throw new Error("Fireworks down")
      },
    })
    expect(items.some((item) => item.kind === "header" && item.displayName === "Hosted")).toBe(
      false,
    )
    expect(items.some((item) => item.kind !== "header" && item.id === "openai/gpt-oss-20b")).toBe(
      true,
    )
  })

  it("puts every PAIR model in one unified section and keeps duplicate engine model IDs distinct", async () => {
    const shared = {
      provider: "pair" as const,
      id: "qwen:latest",
      displayName: "Qwen",
      nativeContextLength: 262_144,
      supportsImageInput: false,
    }
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      pairModels: [
        {
          ...shared,
          baseURL: "http://127.0.0.1:11434",
          engine: "ollama",
        },
        {
          ...shared,
          baseURL: "http://127.0.0.1:1234",
          engine: "lmstudio",
        },
      ],
      currentProvider: "pair",
      currentModel: shared.id,
      currentPairEngine: "lmstudio",
    })

    expect(items.filter((item) => item.kind === "header" && item.id === "header-pair")).toEqual([
      { kind: "header", id: "header-pair", displayName: "NVIDIA PAIR" },
    ])
    const models = items.filter((item) => item.kind === "model" && item.provider === "pair")
    expect(models[0]).toMatchObject({ provider: "pair", active: false })
    expect(models[1]).toMatchObject({ provider: "pair", active: true })
    expect(
      "selectionKey" in models[0] && "selectionKey" in models[1] && models[0].selectionKey,
    ).not.toBe("selectionKey" in models[1] ? models[1].selectionKey : undefined)
  })

  it("does not mark a managed-local row active when PAIR exposes the same model ID", async () => {
    const items = await listModelPickerItems({
      hardware: ample,
      dataDirectory: await tempDir(),
      currentProvider: "pair",
      currentModel: "openai/gpt-oss-20b",
      currentPairEngine: "ollama",
      pairModels: [
        {
          provider: "pair",
          id: "openai/gpt-oss-20b",
          displayName: "gpt-oss 20B",
          baseURL: "http://127.0.0.1:11434",
          engine: "ollama",
          nativeContextLength: 262_144,
          supportsImageInput: false,
        },
      ],
    })

    expect(
      items.find(
        (item) =>
          item.kind === "model" && item.provider === "local" && item.id === "openai/gpt-oss-20b",
      ),
    ).toMatchObject({ active: false })
    expect(
      items.find(
        (item) =>
          item.kind === "model" && item.provider === "pair" && item.id === "openai/gpt-oss-20b",
      ),
    ).toMatchObject({ active: true })
  })

  it("labels context windows without decimal rounding on binary sizes", async () => {
    expect(formatContextWindow(32_768)).toBe("32K")
    expect(formatContextWindow(16_384)).toBe("16K")
    expect(formatContextWindow(8_192)).toBe("8K")
    expect(formatContextWindow(98_304)).toBe("96K")
    expect(formatContextWindow(128_000)).toBe("128K")
    expect(formatContextWindow(262_144)).toBe("256K")
    const items = await listModelPickerItems({ hardware: ample, dataDirectory: await tempDir() })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(
      Object.fromEntries(local.map((item) => [item.id, item.availabilityLabel.split(" ·")[0]])),
    ).toEqual({
      [ORNITH]: "Est. 256K",
      [GEMMA]: "Est. 256K",
      [LFM]: "Est. 128K",
      [QWEN]: "Est. 256K",
      [BONSAI]: "Est. 256K",
      [FLASH]: "Est. 256K",
      [GPT_OSS]: "Est. 128K",
      [GEMMA_A4B]: "Est. 256K",
      [GEMMA_31B]: "Est. 256K",
    })
  })

  it("orders CPU-only rows by the CPU preference so the first row is the fallback", async () => {
    const items = await listModelPickerItems({
      hardware: { ...linuxHardware(32), backend: "cpu", gpuCount: 0 },
      dataDirectory: await tempDir(),
    })
    const local = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local",
    )
    expect(local.map((item) => item.id)).toEqual([
      GPT_OSS,
      GEMMA_A4B,
      ORNITH,
      GEMMA,
      LFM,
      QWEN,
      BONSAI,
      GEMMA_31B,
    ])
    expect(local[0]).toMatchObject({ recommended: true, available: true })
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-picker-"))
  tempDirectories.push(path)
  return path
}

/** IDs of the local rows the picker stars for this hardware, in catalog order. */
async function recommendedIds(hardware: HardwareProbe, dataDirectory?: string) {
  const items = await listModelPickerItems({
    hardware,
    dataDirectory: dataDirectory ?? (await tempDir()),
  })
  return items.flatMap((item) =>
    item.kind === "model" && item.provider === "local" && item.recommended ? [item.id] : [],
  )
}

function localGgufPath(model: LocalModelSpec, directory: string) {
  return join(directory, "models", model.ggufFiles[0].name)
}

/** A detected Mac: the default Metal working set unless `iogpu.wired_limit_mb` is raised. */
function macHardware(ramGiB: number, wiredLimitMiB = 0) {
  return detectHardware({
    env: { platform: "darwin", arch: "arm64", totalMemoryBytes: ramGiB * GIBIBYTE },
    metalWiredLimitMiB: async () => wiredLimitMiB,
  })
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
