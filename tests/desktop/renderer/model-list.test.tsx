import { describe, expect, it } from "vitest"
import {
  mergeModelLoad,
  pickerDetailLabel,
  pickerDetailParts,
} from "../../../src/desktop/renderer/features/models/model-list.js"
import type {
  HostedPickerChoice,
  LocalPickerChoice,
  ModelPickerItem,
  PairPickerChoice,
  ServerPickerChoice,
} from "../../../src/inference/picker-catalog.js"
import { pickerItemKey } from "../../../src/inference/picker-filter.js"

const localItem: ModelPickerItem = {
  kind: "model",
  provider: "local",
  id: "Qwen/Qwen3.8-27B",
  displayName: "Qwen3.8 27B",
  contextLength: 32_768,
  supportsImageInput: false,
  available: true,
  recommended: true,
  availabilityLabel: "Est. 32K · Q4_K_M",
  hasDownloadedPacking: true,
  cpuOffload: false,
  downloaded: true,
  active: false,
}

const pairItem: ModelPickerItem = {
  kind: "model",
  provider: "pair",
  id: "qwen3:32b",
  displayName: "qwen3:32b",
  baseURL: "http://127.0.0.1:11434",
  engine: "ollama",
  supportsImageInput: false,
  available: true,
  active: false,
  selectionKey: "ollama:qwen3:32b",
}

const fireworksItem: ModelPickerItem = {
  kind: "model",
  provider: "fireworks",
  id: "accounts/fireworks/models/kimi-k2p5-turbo",
  displayName: "Kimi K2.5 Turbo",
  supportsImageInput: false,
  available: true,
  active: true,
}

describe("pickerItemKey", () => {
  it("uses the selectionKey for PAIR entries and the provider-qualified id otherwise", () => {
    expect(pickerItemKey(pairItem as never)).toBe("ollama:qwen3:32b")
    expect(pickerItemKey(localItem as never)).toBe("local:Qwen/Qwen3.8-27B")
    expect(pickerItemKey(fireworksItem as never)).toBe(
      "fireworks:accounts/fireworks/models/kimi-k2p5-turbo",
    )
    // A hosted catalog can list the id a local model uses; the rows still key apart.
    expect(pickerItemKey({ ...localItem, provider: "together" } as never)).not.toBe(
      pickerItemKey(localItem as never),
    )
  })
})

describe("pickerDetailLabel", () => {
  it("suffixes local availability with the modality", () => {
    expect(pickerDetailLabel(localItem as LocalPickerChoice)).toBe("Est. 32K · Q4_K_M · Text")
    const vision: LocalPickerChoice = {
      ...(localItem as LocalPickerChoice),
      supportsImageInput: true,
    }
    expect(pickerDetailLabel(vision)).toBe("Est. 32K · Q4_K_M · Vision")
  })

  it("leads PAIR rows with the engine and shows context, quantization, and modality", () => {
    const pair: PairPickerChoice = {
      kind: "model",
      provider: "pair",
      id: "qwen3:32b",
      displayName: "qwen3:32b",
      baseURL: "http://127.0.0.1:11434",
      engine: "ollama",
      supportsImageInput: false,
      available: true,
      active: false,
      selectionKey: "pair:ollama:qwen3:32b",
      nativeContextLength: 262_144,
      quantization: "Q4_K_M",
    }
    expect(pickerDetailLabel(pair)).toBe("Ollama · 256K model max · Q4_K_M · Text")
    expect(pickerDetailLabel({ ...pair, engine: "lmstudio", supportsImageInput: true })).toBe(
      "LM Studio · 256K model max · Q4_K_M · Vision",
    )
    const unknown: PairPickerChoice = {
      ...pair,
      nativeContextLength: undefined,
      quantization: undefined,
    }
    expect(pickerDetailLabel(unknown)).toBe(
      "Ollama · Context unavailable · Quant unavailable · Text",
    )
  })

  it("shows exact hosted context without Est., plus modality", () => {
    const hosted: HostedPickerChoice = {
      kind: "model",
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p5-turbo",
      displayName: "Kimi K2.5 Turbo",
      supportsImageInput: false,
      available: true,
      active: true,
      contextLength: 256_000,
    }
    expect(pickerDetailLabel(hosted)).toBe("256K · Text")
    expect(pickerDetailLabel({ ...hosted, supportsImageInput: true })).toBe("256K · Vision")
    expect(pickerDetailLabel({ ...hosted, contextLength: undefined })).toBe("Text")
  })
})

describe("pickerDetailParts under Favorites", () => {
  it("leads every row but PAIR with its provider, once", () => {
    const labels = (item: Parameters<typeof pickerDetailParts>[0]) =>
      pickerDetailParts(item, undefined, true).map((part) => part.label)
    expect(labels(localItem as LocalPickerChoice)).toEqual(["Local", "Est. 32K · Q4_K_M", "Text"])
    expect(labels(fireworksItem as HostedPickerChoice)[0]).toBe("Fireworks AI")
    expect(labels(pairItem as PairPickerChoice)[0]).toBe("Ollama")
    const server: ServerPickerChoice = {
      kind: "model",
      provider: "omlx",
      id: "mlx-community/gemma-4",
      displayName: "Gemma 4",
      baseURL: "http://127.0.0.1:8000",
      supportsImageInput: false,
      contextLength: 131_072,
      available: true,
      active: false,
      selectionKey: "omlx:mlx-community/gemma-4",
    }
    expect(labels(server)).toEqual(["oMLX", "128K", "Text"])
    expect(pickerDetailLabel(server)).toBe("oMLX · 128K · Text")
    // A server row that cannot serve says why, and under Favorites still names its server.
    const short = { ...server, available: false, availabilityLabel: "Requires 64K context." }
    expect(labels(short)).toEqual(["oMLX", "Requires 64K context.", "Text"])
    expect(pickerDetailLabel(short)).toBe("Requires 64K context. · Text")
  })
})

describe("mergeModelLoad", () => {
  it("returns the list untouched when no load is in flight", () => {
    const items = [localItem, pairItem]
    expect(mergeModelLoad(items, null)).toBe(items)
  })

  it("overlays progress onto the matching row only", () => {
    const merged = mergeModelLoad([localItem, pairItem, fireworksItem], {
      modelId: "ollama:qwen3:32b",
      status: { label: "Loading", kind: "progress" },
    })
    expect(merged[0]).toBe(localItem)
    expect(merged[1]).toMatchObject({ status: { label: "Loading", kind: "progress" } })
    expect(merged[2]).toBe(fireworksItem)
  })

  it("can place an error on a hosted row", () => {
    const merged = mergeModelLoad([fireworksItem], {
      modelId: "fireworks:accounts/fireworks/models/kimi-k2p5-turbo",
      status: { label: "Failed: quota", kind: "error" },
    })
    expect(merged[0]).toMatchObject({ status: { label: "Failed: quota", kind: "error" } })
  })

  it("leaves headers and other rows alone when the id matches nothing", () => {
    const header: ModelPickerItem = { kind: "header", id: "header-local", displayName: "Local" }
    const merged = mergeModelLoad([header, localItem], {
      modelId: "elsewhere",
      status: { label: "Loading", kind: "progress" },
    })
    expect(merged).toEqual([header, localItem])
  })
})
