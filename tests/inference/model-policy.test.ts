import { describe, expect, it } from "vitest"
import { DEFAULT_FIREWORKS_MODEL_IDS, selectDefaultFireworksModel } from "../../src/inference/model-policy.js"
import type { FireworksModel } from "../../src/inference/types.js"

describe("Fireworks default model policy", () => {
  it("prefers Muse Glimmer regardless of catalog order", () => {
    const fallback = model("fallback")
    const inkling = model(DEFAULT_FIREWORKS_MODEL_IDS[1])
    const muse = model(DEFAULT_FIREWORKS_MODEL_IDS[0])

    expect(selectDefaultFireworksModel([fallback, inkling, muse])).toBe(muse)
  })

  it("falls back to Inkling when Muse Glimmer is unavailable", () => {
    const fallback = model("fallback")
    const inkling = model(DEFAULT_FIREWORKS_MODEL_IDS[1])

    expect(selectDefaultFireworksModel([fallback, inkling])).toBe(inkling)
  })

  it("uses the first verified catalog model when neither preferred model is available", () => {
    const first = model("first")

    expect(selectDefaultFireworksModel([first, model("second")])).toBe(first)
  })

  it("returns undefined for an empty catalog", () => {
    expect(selectDefaultFireworksModel([])).toBeUndefined()
  })
})

function model(id: string): FireworksModel {
  return { id, displayName: id, supportsImageInput: false }
}
