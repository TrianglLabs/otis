import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localGgufPath } from "../../src/inference/gguf-cache.js"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import { findLocalModel, LOCAL_MODELS, localModelPackings } from "../../src/inference/local-catalog.js"
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

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
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
    expect(models[0]).toMatchObject({ available: false, availabilityLabel: expect.stringContaining("Requires 64K") })
    expect(isSelectablePickerItem(models[0])).toBe(false)
    expect(isSelectablePickerItem(models[1])).toBe(true)
    expect(isSelectablePickerItem(models[2])).toBe(true)
  })

  it.each([
    [8, ["LiquidAI/LFM2.5-2.6B"]],
    [16, ["prism-ml/Ternary-Bonsai-2-27B-gguf"]],
    [24, ["prism-ml/Ternary-Bonsai-2-27B-gguf"]],
    [32, ["Qwen/Qwen3.8-27B"]],
    [96, ["Qwen/Qwen3.8-Flash-Next"]],
    [196, ["Qwen/Qwen3.8-Flash-Next"]],
    [256, ["Qwen/Qwen3.8-Flash-Next"]],
    [384, ["zai-org/GLM-5.3"]],
    [1024, ["zai-org/GLM-5.3"]],
  ])("marks the recommended fitting models at %d GB", async (memoryGB, modelIds) => {
    const items = await listModelPickerItems({
      hardware: { ...ample, totalMemoryBytes: memoryGB * 1024 ** 3, gpuMemoryBytes: memoryGB * 1024 ** 3 },
      dataDirectory: await tempDir(),
    })
    const recommended = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local" && item.recommended,
    )

    expect(recommended.map((model) => model.id)).toEqual(modelIds)
    expect(recommended.every((model) => model.available)).toBe(true)
  })

  it.each([
    [16, "PTQ1_0"],
    [24, "PQ2_0"],
  ])("shows the selected Bonsai packing at %d GB", async (memoryGB, quant) => {
    const items = await listModelPickerItems({
      hardware: { ...ample, totalMemoryBytes: memoryGB * 1024 ** 3, gpuMemoryBytes: memoryGB * 1024 ** 3 },
      dataDirectory: await tempDir(),
    })
    const bonsai = items.find(
      (item): item is LocalPickerChoice =>
        item.kind === "model" && item.provider === "local" && item.id === "prism-ml/Ternary-Bonsai-2-27B-gguf",
    )
    expect(bonsai?.availabilityLabel).toContain(`· ${quant} ·`)
  })

  it.each([8188, 12288, 16380])("stars the compatible Bonsai packing with %d MiB of Vulkan VRAM", async (gpuMiB) => {
    const items = await listModelPickerItems({
      hardware: {
        platform: "linux",
        arch: "x64",
        backend: "vulkan",
        unifiedMemory: false,
        gpuCount: 1,
        totalMemoryBytes: 15.8 * 1024 ** 3,
        gpuMemoryBytes: gpuMiB * 1024 ** 2,
      },
      dataDirectory: await tempDir(),
    })
    const starred = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local" && item.recommended,
    )
    expect(starred).toHaveLength(1)
    expect(starred[0]?.id).toBe("prism-ml/Ternary-Bonsai-2-27B-gguf")
    expect(starred[0]?.availabilityLabel).toContain("· PTQ1_0 ·")
  })

  it.each([
    [8, 256, "prism-ml/Ternary-Bonsai-2-27B-gguf"],
    [24, 256, "Qwen/Qwen3.8-27B"],
    [48, 256, "Qwen/Qwen3.8-27B"],
    [80, 128, "Qwen/Qwen3.8-Flash-Next"],
    [96, 16, "prism-ml/Ternary-Bonsai-2-27B-gguf"],
  ])("stars the shared GPU-aware choice with %d GiB VRAM and %d GiB RAM", async (gpuGiB, ramGiB, id) => {
    const items = await listModelPickerItems({
      hardware: {
        platform: "linux",
        arch: "x64",
        backend: "vulkan",
        unifiedMemory: false,
        gpuCount: 1,
        totalMemoryBytes: ramGiB * 1024 ** 3,
        gpuMemoryBytes: gpuGiB * 1024 ** 3,
      },
      dataDirectory: await tempDir(),
    })
    const starred = items.filter(
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local" && item.recommended,
    )
    expect(starred.map((item) => item.id)).toEqual([id])
    expect(starred.every(isSelectablePickerItem)).toBe(true)
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
      (item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local" && item.id === model.id,
    )
    expect(bonsai).toMatchObject({ downloaded: false, hasDownloadedPacking: true })
    expect(bonsai?.availabilityLabel).toContain("· PQ2_0 ·")
  })

  it("lists official local models above hosted entries", async () => {
    const items = await listModelPickerItems({
      hardware: { ...ample, totalMemoryBytes: 512 * 1024 ** 3, gpuMemoryBytes: 512 * 1024 ** 3 },
      dataDirectory: await tempDir(),
      currentModel: "accounts/fireworks/models/inkling",
      fireworksApiKey: "fw_test",
      listFireworks: async () => [
        fireworksModel({ id: "accounts/fireworks/models/inkling", displayName: "Inkling", supportsImageInput: false }),
      ],
    })

    expect(items[0]).toEqual({ kind: "header", id: "header-local", displayName: "Local" })
    expect(items.slice(1, 1 + LOCAL_MODELS.length).map((item) => ("id" in item ? item.id : undefined))).toEqual(
      LOCAL_MODELS.map((model) => model.id),
    )
    const hostedHeader = items.findIndex((item) => item.kind === "header" && item.displayName === "Hosted")
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
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
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
      (item): item is LocalPickerChoice => item.kind === "model" && "id" in item && item.id === cached.id,
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
        fireworksModel({ id: "accounts/fireworks/models/alpha", displayName: "Alpha", supportsImageInput: false }),
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
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")

    expect(local.every((item) => item.available)).toBe(true)
    expect(local.every((item) => item.availabilityLabel.startsWith("Est. "))).toBe(true)
  })

  it("greys out local models on unsupported platforms before selection", async () => {
    const items = await listModelPickerItems({
      hardware: { ...ample, platform: "win32", arch: "x64", backend: "cpu", unifiedMemory: false },
      dataDirectory: await tempDir(),
    })
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")

    expect(local.every((item) => !item.available)).toBe(true)
    expect(local.every((item) => !item.recommended)).toBe(true)
    expect(local.every((item) => item.availabilityLabel === "Local inference is not supported on win32/x64.")).toBe(
      true,
    )
  })

  it("marks local models that are already on disk", async () => {
    const directory = await tempDir()
    const cached = LOCAL_MODELS.find((model) => model.id === "openai/gpt-oss-20b")
    if (!cached) throw new Error("missing catalog entry")
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(localGgufPath(cached, directory), "")
    await truncate(localGgufPath(cached, directory), cached.ggufFiles[0].size)

    const items = await listModelPickerItems({ hardware: ample, dataDirectory: directory })
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
    expect(local.find((item) => item.id === cached.id)?.downloaded).toBe(true)
    expect(local.filter((item) => item.id !== cached.id).every((item) => item.downloaded === false)).toBe(true)
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
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
    const active = local.find((item) => item.id === model.id)

    expect(active).toMatchObject({
      active: true,
      contextLength: 80_128,
      loadedContextLength: 80_128,
    })
    expect(active?.availabilityLabel).toMatch(/^80K · Q4_K_M · /)
    expect(
      local.filter((item) => item.id !== model.id).every((item) => item.availabilityLabel.startsWith("Est. ")),
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
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
    expect(local.find((item) => item.id === "openai/gpt-oss-20b")?.status).toEqual({
      label: "Downloading 47%",
      kind: "progress",
    })
    expect(local.filter((item) => item.id !== "openai/gpt-oss-20b").every((item) => item.status === undefined)).toBe(
      true,
    )
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
      loadStatus: { modelId: "pair:ollama:qwen3:32b", status: { label: "Failed: endpoint went away", kind: "error" } },
    })
    const pair = items.filter((item): item is PairPickerChoice => item.kind === "model" && item.provider === "pair")
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
    expect(items.some((item) => item.kind === "header" && item.displayName === "Hosted")).toBe(false)
    expect(items.some((item) => item.kind !== "header" && item.id === "openai/gpt-oss-20b")).toBe(true)
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
    expect("selectionKey" in models[0] && "selectionKey" in models[1] && models[0].selectionKey).not.toBe(
      "selectionKey" in models[1] ? models[1].selectionKey : undefined,
    )
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
      items.find((item) => item.kind === "model" && item.provider === "local" && item.id === "openai/gpt-oss-20b"),
    ).toMatchObject({ active: false })
    expect(
      items.find((item) => item.kind === "model" && item.provider === "pair" && item.id === "openai/gpt-oss-20b"),
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
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
    expect(local.map((item) => item.availabilityLabel.split(" ·")[0])).toEqual([
      "Est. 256K",
      "Est. 256K",
      "Est. 128K",
      "Est. 256K",
      "Est. 256K",
      "Est. 256K",
      "Est. 128K",
      "Est. 256K",
      "Est. 256K",
    ])
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-picker-"))
  tempDirectories.push(path)
  return path
}
