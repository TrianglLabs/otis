import { describe, expect, it } from "vitest"
import {
  mergeModelLoad,
  pickerDetailLabel,
  pickerItemKey,
} from "../../../src/desktop/renderer/features/models/model-list.js"
import type {
  FireworksPickerChoice,
  LocalPickerChoice,
  ModelPickerItem,
  PairPickerChoice,
} from "../../../src/inference/picker-catalog.js"

const localItem: ModelPickerItem = {
  kind: "model",
  provider: "local",
  id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  displayName: "Qwen Coder",
  contextLength: 32_768,
  supportsImageInput: false,
  available: true,
  recommended: true,
  availabilityLabel: "Est. 32K · Q4_K_M · 18 GB",
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
  it("uses the selectionKey for PAIR entries and the plain id otherwise", () => {
    expect(pickerItemKey(pairItem as never)).toBe("ollama:qwen3:32b")
    expect(pickerItemKey(localItem as never)).toBe("Qwen/Qwen3-Coder-30B-A3B-Instruct")
    expect(pickerItemKey(fireworksItem as never)).toBe("accounts/fireworks/models/kimi-k2p5-turbo")
  })
})

// These strings mirror modelMeta in the TUI's model picker (src/cli/ui/model-picker.ts) exactly.
describe("pickerDetailLabel", () => {
  it("suffixes local availability with the modality", () => {
    expect(pickerDetailLabel(localItem as LocalPickerChoice)).toBe("Est. 32K · Q4_K_M · 18 GB · Text")
    const vision: LocalPickerChoice = { ...(localItem as LocalPickerChoice), supportsImageInput: true }
    expect(pickerDetailLabel(vision)).toBe("Est. 32K · Q4_K_M · 18 GB · Vision")
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
    const unknown: PairPickerChoice = { ...pair, nativeContextLength: undefined, quantization: undefined }
    expect(pickerDetailLabel(unknown)).toBe("Ollama · Context unavailable · Quant unavailable · Text")
  })

  it("shows exact hosted context without Est., plus modality and fast mode", () => {
    const hosted: FireworksPickerChoice = {
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
    expect(pickerDetailLabel({ ...hosted, fastId: "accounts/fireworks/models/kimi-k2p5-turbo-fast" })).toBe(
      "256K · Text · Fast mode",
    )
    expect(pickerDetailLabel({ ...hosted, contextLength: undefined })).toBe("Text")
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
      modelId: "accounts/fireworks/models/kimi-k2p5-turbo",
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
