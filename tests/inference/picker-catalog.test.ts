import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localGgufPath } from "../../src/inference/gguf-cache.js"
import type { HardwareProbe } from "../../src/inference/hardware.js"
import { LOCAL_MODELS } from "../../src/inference/local-catalog.js"
import {
  formatContextWindow,
  type LocalPickerChoice,
  listModelPickerItems,
} from "../../src/inference/picker-catalog.js"
import { fireworksModel } from "../../src/inference/types.js"

const ample: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 128 * 1024 ** 3,
  gpuMemoryBytes: 128 * 1024 ** 3,
  backend: "metal",
  unifiedMemory: true,
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
  it("lists official local models above hosted entries", async () => {
    const items = await listModelPickerItems({
      hardware: ample,
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

  it("keeps local models visible but unavailable when they cannot fit", async () => {
    const items = await listModelPickerItems({ hardware: tight, dataDirectory: await tempDir() })
    const local = items.filter((item): item is LocalPickerChoice => item.kind === "model" && item.provider === "local")
    expect(local).toHaveLength(LOCAL_MODELS.length)
    expect(local.every((item) => item.available === false)).toBe(true)
    expect(local.every((item) => item.availabilityLabel.startsWith("Needs "))).toBe(true)
    expect(local.every((item) => item.downloaded === false)).toBe(true)
  })

  it("keeps hybrid-offload models available when system RAM is sufficient", async () => {
    const smallGpu: HardwareProbe = {
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 64 * 1024 ** 3,
      gpuMemoryBytes: 8 * 1024 ** 3,
      backend: "vulkan",
      unifiedMemory: false,
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
    await truncate(localGgufPath(cached, directory), cached.weightBytes)

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
    expect(active?.availabilityLabel).toMatch(/^80K loaded · Q4_K_M · /)
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
    ])
  })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-picker-"))
  tempDirectories.push(path)
  return path
}
